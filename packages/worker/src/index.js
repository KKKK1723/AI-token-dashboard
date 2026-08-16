import { summarizeRows, summaryDateRange, validateSyncPayload } from "./core.js";

const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_CODE = /^atdp_[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN = /^atdt_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TEXT_ENCODER = new TextEncoder();

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function bearerToken(request) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") || "");
  return match ? match[1] : null;
}

async function digestSecret(value) {
  return crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
}

function equalDigests(left, right) {
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(left, right);
  }
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function authorized(request, expected) {
  const provided = bearerToken(request);
  if (!provided || !expected) return false;
  const [providedHash, expectedHash] = await Promise.all([
    digestSecret(provided),
    digestSecret(expected),
  ]);
  return equalDigests(providedHash, expectedHash);
}

async function tokenHash(value) {
  const digest = new Uint8Array(await digestSecret(value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return prefix + encoded;
}

async function readJsonLimited(request, maximumBytes) {
  const advertisedLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    throw new HttpError("request body is too large", 413);
  }
  if (!request.body) throw new HttpError("request body must be valid JSON");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new HttpError("request body is too large", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("request body must be valid JSON");
  }
}

function validatePairRequest(value) {
  if (!value || !PAIRING_CODE.test(value.code || "")) {
    throw new HttpError("pairing code is invalid");
  }
  const deviceName = typeof value.deviceName === "string" ? value.deviceName.trim() : "";
  if (!deviceName || deviceName.length > 120) {
    throw new HttpError("deviceName must be a non-empty string of at most 120 characters");
  }
  if (
    value.timezone != null &&
    (typeof value.timezone !== "string" || !value.timezone || value.timezone.length > 80)
  ) {
    throw new HttpError("timezone must be a non-empty string of at most 80 characters");
  }
  return { code: value.code, deviceName, timezone: value.timezone || null };
}

async function issuePairingCode(request, env) {
  if (!(await authorized(request, env.SYNC_KEY))) {
    return json({ error: "unauthorized" }, 401);
  }
  const code = randomToken("atdp_");
  const codeHash = await tokenHash(code);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + PAIRING_TTL_MS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?1").bind(createdAt.toISOString()),
    env.DB.prepare(
      "INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?1, ?2, ?3)",
    ).bind(codeHash, createdAt.toISOString(), expiresAt.toISOString()),
  ]);
  return json({ ok: true, code, expiresAt: expiresAt.toISOString() });
}

async function redeemPairing(request, env) {
  let pairing;
  try {
    pairing = validatePairRequest(await readJsonLimited(request, 16 * 1024));
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }
  const accountTimezone = env.DASHBOARD_TIMEZONE || "Asia/Shanghai";
  if (pairing.timezone && pairing.timezone !== accountTimezone) {
    return json({ error: `timezone must be ${accountTimezone}` }, 400);
  }

  const deviceToken = randomToken("atdt_");
  const [codeHash, deviceTokenHash] = await Promise.all([
    tokenHash(pairing.code),
    tokenHash(deviceToken),
  ]);
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO device_credentials (
         token_hash, device_id, device_name, created_at, last_used_at, revoked_at
       )
       SELECT ?1, NULL, ?2, ?3, NULL, NULL
       FROM pairing_codes
       WHERE code_hash = ?4 AND expires_at > ?3`,
    ).bind(deviceTokenHash, pairing.deviceName, now, codeHash),
    env.DB.prepare("DELETE FROM pairing_codes WHERE code_hash = ?1").bind(codeHash),
  ]);
  if (results[0]?.meta?.changes !== 1) {
    return json({ error: "pairing code is invalid, expired, or already used" }, 400);
  }
  return json({
    ok: true,
    deviceToken,
    timezone: accountTimezone,
  });
}

async function authorizeSync(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  if (await authorized(request, env.SYNC_KEY)) return { kind: "master" };
  if (!DEVICE_TOKEN.test(token)) return null;
  const hash = await tokenHash(token);
  const credential = await env.DB.prepare(
    `SELECT device_id
     FROM device_credentials
     WHERE token_hash = ?1 AND revoked_at IS NULL`,
  )
    .bind(hash)
    .first();
  return credential ? { kind: "device", tokenHash: hash } : null;
}

async function bindDeviceCredential(env, authorization, payload, now) {
  if (authorization.kind !== "device") return true;
  const result = await env.DB.prepare(
    `UPDATE device_credentials
     SET device_id = COALESCE(device_id, ?1),
         device_name = ?2,
         last_used_at = ?3
     WHERE token_hash = ?4
       AND revoked_at IS NULL
       AND (device_id IS NULL OR device_id = ?1)`,
  )
    .bind(payload.deviceId, payload.deviceName, now, authorization.tokenHash)
    .run();
  return result.meta.changes === 1;
}

function validateLoopbackRedirect(value) {
  let redirect;
  try {
    redirect = new URL(value);
  } catch {
    throw new HttpError("redirectUri is invalid");
  }
  const port = Number(redirect.port);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== "/oauth/callback" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new HttpError("redirectUri must be a 127.0.0.1 OAuth callback");
  }
  return redirect.toString();
}

function validateOAuthExchange(value) {
  if (!value || typeof value !== "object") {
    throw new HttpError("request body is invalid");
  }
  if (typeof value.code !== "string" || !value.code || value.code.length > 512) {
    throw new HttpError("code is invalid");
  }
  if (!PKCE_VERIFIER.test(value.codeVerifier || "")) {
    throw new HttpError("codeVerifier is invalid");
  }
  if (!UUID.test(value.deviceId || "")) {
    throw new HttpError("deviceId must be a UUID");
  }
  const deviceName = typeof value.deviceName === "string" ? value.deviceName.trim() : "";
  if (!deviceName || deviceName.length > 120) {
    throw new HttpError("deviceName must be a non-empty string of at most 120 characters");
  }
  if (
    value.timezone != null &&
    (typeof value.timezone !== "string" || !value.timezone || value.timezone.length > 80)
  ) {
    throw new HttpError("timezone must be a non-empty string of at most 80 characters");
  }
  return {
    code: value.code,
    codeVerifier: value.codeVerifier,
    redirectUri: validateLoopbackRedirect(value.redirectUri),
    deviceId: value.deviceId.toLowerCase(),
    deviceName,
    timezone: value.timezone || null,
  };
}

function githubHeaders(extra = {}) {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "ai-token-dashboard-worker",
    "x-github-api-version": "2022-11-28",
    ...extra,
  };
}

async function revokeGithubToken(env, accessToken) {
  const credentials = btoa(
    `${env.GITHUB_OAUTH_CLIENT_ID}:${env.GITHUB_OAUTH_CLIENT_SECRET}`,
  );
  const response = await fetch(
    `https://api.github.com/applications/${encodeURIComponent(env.GITHUB_OAUTH_CLIENT_ID)}/token`,
    {
      method: "DELETE",
      headers: githubHeaders({
        authorization: `Basic ${credentials}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ access_token: accessToken }),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub token revocation returned HTTP ${response.status}`);
  }
}

function githubOAuthConfigured(env) {
  const allowedUserId = Number(env.GITHUB_ALLOWED_USER_ID);
  return Boolean(
    env.GITHUB_OAUTH_CLIENT_ID &&
      env.GITHUB_OAUTH_CLIENT_SECRET &&
      Number.isSafeInteger(allowedUserId) &&
      allowedUserId > 0,
  );
}

function githubOAuthConfig(env) {
  if (!githubOAuthConfigured(env)) {
    return json({ error: "GitHub OAuth is not configured" }, 503);
  }
  return json({
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    authorizeUrl: "https://github.com/login/oauth/authorize",
  });
}

async function exchangeGithubCode(env, oauth) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "ai-token-dashboard-worker",
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code: oauth.code,
      redirect_uri: oauth.redirectUri,
      code_verifier: oauth.codeVerifier,
    }),
  });
  const value = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    value.error ||
    typeof value.access_token !== "string" ||
    (value.scope != null && typeof value.scope !== "string")
  ) {
    throw new HttpError("GitHub authorization code exchange failed", 401);
  }
  return {
    accessToken: value.access_token,
    scope: value.scope || "",
  };
}

async function githubIdentity(accessToken) {
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders({ authorization: `Bearer ${accessToken}` }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !Number.isSafeInteger(value.id)) {
    throw new HttpError("Unable to verify the GitHub account", 502);
  }
  return value;
}

async function exchangeGithubOAuth(request, env) {
  if (!githubOAuthConfigured(env)) {
    return json({ error: "GitHub OAuth is not configured" }, 503);
  }
  let oauth;
  try {
    oauth = validateOAuthExchange(await readJsonLimited(request, 32 * 1024));
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }
  const accountTimezone = env.DASHBOARD_TIMEZONE || "Asia/Shanghai";
  if (oauth.timezone && oauth.timezone !== accountTimezone) {
    return json({ error: `timezone must be ${accountTimezone}` }, 400);
  }

  let accessToken = null;
  try {
    const authorization = await exchangeGithubCode(env, oauth);
    accessToken = authorization.accessToken;
    if (authorization.scope.trim()) {
      throw new HttpError("GitHub authorization granted unexpected scopes", 403);
    }
    const identity = await githubIdentity(accessToken);
    if (identity.id !== Number(env.GITHUB_ALLOWED_USER_ID)) {
      throw new HttpError("This GitHub account is not authorized", 403);
    }
    await revokeGithubToken(env, accessToken);
    accessToken = null;
    const deviceToken = randomToken("atdt_");
    const deviceTokenHash = await tokenHash(deviceToken);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO device_credentials (
         token_hash, device_id, device_name, created_at, last_used_at, revoked_at
       ) VALUES (?1, ?2, ?3, ?4, NULL, NULL)`,
    )
      .bind(deviceTokenHash, oauth.deviceId, oauth.deviceName, now)
      .run();
    return json({
      ok: true,
      deviceToken,
      timezone: accountTimezone,
      github: { id: identity.id, login: identity.login || null },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    if (error.message?.startsWith("GitHub token revocation returned")) {
      return json({ error: "Unable to finalize GitHub authorization" }, 502);
    }
    throw error;
  } finally {
    if (accessToken) {
      await revokeGithubToken(env, accessToken).catch((error) => {
        console.error(JSON.stringify({
          event: "github_token_revoke_failed",
          message: error.message,
        }));
      });
    }
  }
}

function syncResponse(payload, { idempotent = false } = {}) {
  return json({
    ok: true,
    deviceId: payload.deviceId,
    sequence: payload.sequence,
    snapshotId: payload.snapshotId,
    buckets: payload.buckets.length,
    idempotent,
  });
}

async function matchingSyncRun(env, payload, payloadHash) {
  const result = await env.DB.prepare(
    `SELECT snapshot_id, sequence, payload_hash
     FROM sync_runs
     WHERE device_id = ?1 AND (snapshot_id = ?2 OR sequence = ?3)`,
  )
    .bind(payload.deviceId, payload.snapshotId, payload.sequence)
    .all();
  const runs = result.results || [];
  const exact = runs.some(
    (run) =>
      run.snapshot_id === payload.snapshotId &&
      Number(run.sequence) === payload.sequence &&
      run.payload_hash === payloadHash,
  );
  return { exists: runs.length > 0, exact };
}

async function syncUsageV2(env, payload, now) {
  const payloadHash = await tokenHash(JSON.stringify(payload));
  let prior = await matchingSyncRun(env, payload, payloadHash);
  if (prior.exact) return syncResponse(payload, { idempotent: true });
  if (prior.exists) {
    return json({ error: "sequence or snapshotId already exists with different content" }, 409);
  }
  const device = await env.DB.prepare(
    "SELECT last_sequence FROM devices WHERE device_id = ?1",
  )
    .bind(payload.deviceId)
    .first();
  if (device && Number(device.last_sequence) >= payload.sequence) {
    return json({ error: "sequence must be greater than the device's last sequence" }, 409);
  }

  const bucketJson = JSON.stringify(payload.buckets);
  const statements = [
    env.DB.prepare(
      `INSERT INTO devices (
         device_id, device_name, timezone, first_seen_at, last_seen_at, last_sequence, collector_version
       ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
       ON CONFLICT(device_id) DO UPDATE SET
         device_name = excluded.device_name,
         timezone = excluded.timezone,
         last_seen_at = excluded.last_seen_at,
         last_sequence = excluded.last_sequence,
         collector_version = excluded.collector_version
       WHERE excluded.last_sequence > devices.last_sequence`,
    ).bind(
      payload.deviceId,
      payload.deviceName,
      payload.timezone,
      now,
      payload.sequence,
      payload.collectorVersion,
    ),
    env.DB.prepare(
      `INSERT INTO sync_runs (
         device_id, snapshot_id, sequence, payload_hash, window_start_date,
         window_end_date, bucket_count, created_at
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE (SELECT last_sequence FROM devices WHERE device_id = ?1) = ?3`,
    ).bind(
      payload.deviceId,
      payload.snapshotId,
      payload.sequence,
      payloadHash,
      payload.windowStartDate,
      payload.windowEndDate,
      payload.buckets.length,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM daily_usage
       WHERE device_id = ?1
         AND usage_date >= ?2
         AND usage_date <= ?3
         AND (SELECT last_sequence FROM devices WHERE device_id = ?1) = ?4`,
    ).bind(
      payload.deviceId,
      payload.windowStartDate,
      payload.windowEndDate,
      payload.sequence,
    ),
    env.DB.prepare(
      `INSERT INTO daily_usage (
         device_id, usage_date, source, model, requests, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_picos, data_through, sequence, updated_at
       )
       SELECT ?1,
              json_extract(value, '$.date'),
              json_extract(value, '$.source'),
              json_extract(value, '$.model'),
              json_extract(value, '$.requests'),
              json_extract(value, '$.inputTokens'),
              json_extract(value, '$.outputTokens'),
              json_extract(value, '$.cacheReadTokens'),
              json_extract(value, '$.cacheCreationTokens'),
              CAST(json_extract(value, '$.costPicos') AS TEXT),
              json_extract(value, '$.dataThrough'),
              ?3,
              ?4
       FROM json_each(?2)
       WHERE (SELECT last_sequence FROM devices WHERE device_id = ?1) = ?3`,
    ).bind(payload.deviceId, bucketJson, payload.sequence, now),
  ];
  try {
    const results = await env.DB.batch(statements);
    if (results[1]?.meta?.changes !== 1) {
      prior = await matchingSyncRun(env, payload, payloadHash);
      if (prior.exact) return syncResponse(payload, { idempotent: true });
      if (prior.exists) {
        return json({ error: "sequence or snapshotId already exists with different content" }, 409);
      }
      return json({ error: "sequence must be greater than the device's last sequence" }, 409);
    }
  } catch (error) {
    prior = await matchingSyncRun(env, payload, payloadHash);
    if (prior.exact) return syncResponse(payload, { idempotent: true });
    if (prior.exists) {
      return json({ error: "sequence or snapshotId already exists with different content" }, 409);
    }
    throw error;
  }
  return syncResponse(payload);
}


async function syncUsage(request, env) {
  const authorization = await authorizeSync(request, env);
  if (!authorization) return json({ error: "unauthorized" }, 401);
  let payload;
  try {
    payload = validateSyncPayload(await readJsonLimited(request, 1024 * 1024));
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }
  const accountTimezone = env.DASHBOARD_TIMEZONE || "Asia/Shanghai";
  if (payload.timezone !== accountTimezone) {
    return json({ error: `timezone must be ${accountTimezone}` }, 400);
  }
  const now = new Date().toISOString();
  if (!(await bindDeviceCredential(env, authorization, payload, now))) {
    return json({ error: "device credential is already bound to another device" }, 403);
  }
  if (payload.schemaVersion === 2) {
    return syncUsageV2(env, payload, now);
  }
  await env.DB.prepare(
    `INSERT INTO devices (
       device_id, device_name, timezone, first_seen_at, last_seen_at, last_sequence, collector_version
     ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
     ON CONFLICT(device_id) DO UPDATE SET
       device_name = excluded.device_name,
       timezone = excluded.timezone,
       last_seen_at = excluded.last_seen_at,
       last_sequence = MAX(devices.last_sequence, excluded.last_sequence),
       collector_version = excluded.collector_version`,
  )
    .bind(payload.deviceId, payload.deviceName, payload.timezone, now, payload.sequence, payload.collectorVersion)
    .run();

  const statements = payload.buckets.map((bucket) =>
    env.DB.prepare(
      `INSERT INTO daily_usage (
         device_id, usage_date, source, model, requests, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_picos, data_through, sequence, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       ON CONFLICT(device_id, usage_date, source, model) DO UPDATE SET
         requests = excluded.requests,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         cost_picos = excluded.cost_picos,
         data_through = excluded.data_through,
         sequence = excluded.sequence,
         updated_at = excluded.updated_at
       WHERE excluded.sequence > daily_usage.sequence`,
    ).bind(
      payload.deviceId,
      bucket.date,
      bucket.source,
      bucket.model,
      bucket.requests,
      bucket.inputTokens,
      bucket.outputTokens,
      bucket.cacheReadTokens,
      bucket.cacheCreationTokens,
      bucket.costPicos,
      bucket.dataThrough,
      payload.sequence,
      now,
    ),
  );
  for (let offset = 0; offset < statements.length; offset += 80) {
    await env.DB.batch(statements.slice(offset, offset + 80));
  }
  return json({ ok: true, deviceId: payload.deviceId, sequence: payload.sequence, buckets: payload.buckets.length });
}

async function getSummary(request, env) {
  if (!(await authorized(request, env.READ_KEY))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days") || 30);
  const timezone = env.DASHBOARD_TIMEZONE || "Asia/Shanghai";
  const now = url.searchParams.has("now") ? new Date(url.searchParams.get("now")) : new Date();
  if (Number.isNaN(now.getTime())) return json({ error: "invalid now" }, 400);
  let range;
  try {
    range = summaryDateRange(now, timezone, days);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const result = await env.DB.prepare(
    `SELECT model, requests, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, cost_picos, data_through
     FROM daily_usage
     WHERE usage_date >= ?1 AND usage_date <= ?2`,
  )
    .bind(range.start, range.end)
    .all();
  return json(summarizeRows(result.results || [], { ...range, generatedAt: now }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "ai-token-dashboard" });
      }
      if (request.method === "POST" && url.pathname === "/v1/pairing-codes") {
        return issuePairingCode(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/pair") {
        return redeemPairing(request, env);
      }
      if (request.method === "GET" && url.pathname === "/v1/oauth/github/config") {
        return githubOAuthConfig(env);
      }
      if (request.method === "POST" && url.pathname === "/v1/oauth/github/exchange") {
        return exchangeGithubOAuth(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/sync") {
        return syncUsage(request, env);
      }
      if (request.method === "GET" && url.pathname === "/v1/summary") {
        return getSummary(request, env);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({
        event: "request_failed",
        method: request.method,
        path: url.pathname,
        message: error.message,
      }));
      return json({ error: "internal server error" }, 500);
    }
  },
};
