import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const MASTER_KEY = "master-sync-secret";
const TIMEZONE = "Asia/Shanghai";

function result(changes = 0, results = []) {
  return {
    success: true,
    meta: { changes },
    results,
  };
}

class MemoryStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.values = values;
  }

  bind(...values) {
    return new MemoryStatement(this.database, this.sql, values);
  }

  run() {
    return Promise.resolve(this.database.execute(this, "run"));
  }

  all() {
    return Promise.resolve(this.database.execute(this, "all"));
  }

  first() {
    return Promise.resolve(this.database.execute(this, "first"));
  }
}

class MemoryD1 {
  constructor() {
    this.pairingCodes = new Map();
    this.credentials = new Map();
    this.devices = new Map();
    this.dailyUsage = new Map();
    this.syncRuns = [];
    this.beforeBatch = null;
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      await hook();
    }
    const snapshot = structuredClone({
      pairingCodes: this.pairingCodes,
      credentials: this.credentials,
      devices: this.devices,
      dailyUsage: this.dailyUsage,
      syncRuns: this.syncRuns,
    });
    try {
      return statements.map((statement) => this.execute(statement, "run"));
    } catch (error) {
      this.pairingCodes = snapshot.pairingCodes;
      this.credentials = snapshot.credentials;
      this.devices = snapshot.devices;
      this.dailyUsage = snapshot.dailyUsage;
      this.syncRuns = snapshot.syncRuns;
      throw error;
    }
  }

  execute(statement, mode) {
    const { sql, values } = statement;
    if (sql.startsWith("DELETE FROM pairing_codes WHERE expires_at")) {
      let changes = 0;
      for (const [hash, pairing] of this.pairingCodes) {
        if (pairing.expiresAt <= values[0]) {
          this.pairingCodes.delete(hash);
          changes += 1;
        }
      }
      return result(changes);
    }
    if (sql.startsWith("INSERT INTO pairing_codes")) {
      const [hash, createdAt, expiresAt] = values;
      if (this.pairingCodes.has(hash)) throw new Error("UNIQUE constraint failed");
      this.pairingCodes.set(hash, { createdAt, expiresAt });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO device_credentials") && sql.includes("SELECT ?1")) {
      const [tokenHash, deviceName, createdAt, codeHash] = values;
      const pairing = this.pairingCodes.get(codeHash);
      if (!pairing || pairing.expiresAt <= createdAt) return result(0);
      if (this.credentials.has(tokenHash)) throw new Error("UNIQUE constraint failed");
      this.credentials.set(tokenHash, {
        deviceId: null,
        deviceName,
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
      });
      return result(1);
    }
    if (sql.startsWith("DELETE FROM pairing_codes WHERE code_hash")) {
      return result(this.pairingCodes.delete(values[0]) ? 1 : 0);
    }
    if (sql.startsWith("SELECT device_id FROM device_credentials")) {
      const credential = this.credentials.get(values[0]);
      const row = credential && !credential.revokedAt
        ? { device_id: credential.deviceId }
        : null;
      if (mode === "first") return row;
      return result(0, row ? [row] : []);
    }
    if (sql.startsWith("UPDATE device_credentials")) {
      const [deviceId, deviceName, lastUsedAt, tokenHash] = values;
      const credential = this.credentials.get(tokenHash);
      if (
        !credential ||
        credential.revokedAt ||
        (credential.deviceId && credential.deviceId !== deviceId)
      ) {
        return result(0);
      }
      credential.deviceId ||= deviceId;
      credential.deviceName = deviceName;
      credential.lastUsedAt = lastUsedAt;
      return result(1);
    }
    if (sql.startsWith("SELECT snapshot_id, sequence, payload_hash FROM sync_runs")) {
      const [deviceId, snapshotId, sequence] = values;
      const rows = this.syncRuns
        .filter(
          (run) =>
            run.device_id === deviceId &&
            (run.snapshot_id === snapshotId || run.sequence === sequence),
        )
        .map((run) => ({ ...run }));
      if (mode === "first") return rows[0] || null;
      return result(0, rows);
    }
    if (sql.startsWith("SELECT last_sequence FROM devices")) {
      const device = this.devices.get(values[0]);
      const row = device ? { last_sequence: device.lastSequence } : null;
      if (mode === "first") return row;
      return result(0, row ? [row] : []);
    }
    if (sql.startsWith("INSERT INTO devices")) {
      const [deviceId, deviceName, timezone, now, sequence, collectorVersion] = values;
      const existing = this.devices.get(deviceId);
      if (existing && sequence <= existing.lastSequence) return result(0);
      this.devices.set(deviceId, {
        deviceName,
        timezone,
        firstSeenAt: existing?.firstSeenAt || now,
        lastSeenAt: now,
        lastSequence: sequence,
        collectorVersion,
      });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO device_credentials") && sql.includes("VALUES")) {
      const [tokenHash, deviceId, deviceName, createdAt] = values;
      if (this.credentials.has(tokenHash)) throw new Error("UNIQUE constraint failed");
      this.credentials.set(tokenHash, {
        deviceId,
        deviceName,
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
      });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO sync_runs")) {
      const [
        deviceId,
        snapshotId,
        sequence,
        payloadHash,
        windowStartDate,
        windowEndDate,
        bucketCount,
        createdAt,
      ] = values;
      if (this.devices.get(deviceId)?.lastSequence !== sequence) {
        return result(0);
      }
      if (
        this.syncRuns.some(
          (run) =>
            run.device_id === deviceId &&
            (run.snapshot_id === snapshotId || run.sequence === sequence),
        )
      ) {
        throw new Error("UNIQUE constraint failed");
      }
      this.syncRuns.push({
        device_id: deviceId,
        snapshot_id: snapshotId,
        sequence,
        payload_hash: payloadHash,
        windowStartDate,
        windowEndDate,
        bucketCount,
        createdAt,
      });
      return result(1);
    }
    if (sql.startsWith("DELETE FROM daily_usage")) {
      const [deviceId, start, end, sequence] = values;
      if (this.devices.get(deviceId)?.lastSequence !== sequence) {
        return result(0);
      }
      let changes = 0;
      for (const [key, bucket] of this.dailyUsage) {
        if (bucket.deviceId === deviceId && bucket.date >= start && bucket.date <= end) {
          this.dailyUsage.delete(key);
          changes += 1;
        }
      }
      return result(changes);
    }
    if (sql.startsWith("INSERT INTO daily_usage") && sql.includes("json_each")) {
      const [deviceId, bucketJson, sequence, updatedAt] = values;
      if (this.devices.get(deviceId)?.lastSequence !== sequence) {
        return result(0);
      }
      const buckets = JSON.parse(bucketJson);
      for (const bucket of buckets) {
        const key = JSON.stringify([deviceId, bucket.date, bucket.source, bucket.model]);
        this.dailyUsage.set(key, { deviceId, ...bucket, sequence, updatedAt });
      }
      return result(buckets.length);
    }
    throw new Error(`Unsupported test SQL: ${sql}`);
  }
}

function environment(database) {
  return {
    DB: database,
    SYNC_KEY: MASTER_KEY,
    READ_KEY: "read-secret",
    DASHBOARD_TIMEZONE: TIMEZONE,
    GITHUB_ALLOWED_USER_ID: "181867828",
    GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
  };
}

function request(path, { token, body, method = "POST" } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://worker.test${path}`, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

async function createPairing(database) {
  const response = await worker.fetch(
    request("/v1/pairing-codes", { token: MASTER_KEY }),
    environment(database),
  );
  const value = await responseJson(response);
  assert.equal(value.status, 200);
  return value.body;
}

async function redeem(database, code, extra = {}) {
  return responseJson(await worker.fetch(
    request("/v1/pair", {
      body: { code, deviceName: "laptop", ...extra },
    }),
    environment(database),
  ));
}

function syncPayload(deviceId, sequence = 1) {
  return {
    schemaVersion: 1,
    deviceId,
    deviceName: "laptop",
    timezone: TIMEZONE,
    collectorVersion: "2.1.0",
    sequence,
    buckets: [],
  };
}

function atomicSyncPayload(deviceId, sequence, snapshotId, buckets = []) {
  return {
    ...syncPayload(deviceId, sequence),
    schemaVersion: 2,
    snapshotId,
    windowStartDate: "2026-07-01",
    windowEndDate: "2026-07-31",
    buckets,
  };
}

test("pairing code is single-use and only token hashes are persisted", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  assert.match(pairing.code, /^atdp_[A-Za-z0-9_-]{43}$/);
  assert.equal([...database.pairingCodes.keys()].some((key) => key === pairing.code), false);

  const first = await redeem(database, pairing.code);
  assert.equal(first.status, 200);
  assert.match(first.body.deviceToken, /^atdt_[A-Za-z0-9_-]{43}$/);
  assert.equal([...database.credentials.keys()].some((key) => key === first.body.deviceToken), false);

  const replay = await redeem(database, pairing.code);
  assert.equal(replay.status, 400);
  assert.match(replay.body.error, /already used/);
});

test("expired pairing code is rejected and consumed", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  for (const value of database.pairingCodes.values()) {
    value.expiresAt = "2000-01-01T00:00:00.000Z";
  }

  const expired = await redeem(database, pairing.code);
  assert.equal(expired.status, 400);
  assert.equal(database.pairingCodes.size, 0);
});

test("timezone mismatch does not consume the pairing code", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  const mismatch = await redeem(database, pairing.code, { timezone: "UTC" });
  assert.equal(mismatch.status, 400);
  assert.equal(database.pairingCodes.size, 1);

  const accepted = await redeem(database, pairing.code, { timezone: TIMEZONE });
  assert.equal(accepted.status, 200);
});

test("device credential binds once and rejects another device id", async () => {
  const database = new MemoryD1();
  const pairing = await createPairing(database);
  const paired = await redeem(database, pairing.code);
  const deviceToken = paired.body.deviceToken;
  const firstDevice = "019fa6c8-7519-7ba0-9145-b2bf35fec800";
  const otherDevice = "019fa6c8-7519-7ba0-9145-b2bf35fec801";

  const first = await responseJson(await worker.fetch(
    request("/v1/sync", { token: deviceToken, body: syncPayload(firstDevice) }),
    environment(database),
  ));
  assert.equal(first.status, 200);
  assert.equal([...database.credentials.values()][0].deviceId, firstDevice);

  const repeat = await responseJson(await worker.fetch(
    request("/v1/sync", { token: deviceToken, body: syncPayload(firstDevice, 2) }),
    environment(database),
  ));
  assert.equal(repeat.status, 200);

  const conflict = await responseJson(await worker.fetch(
    request("/v1/sync", { token: deviceToken, body: syncPayload(otherDevice) }),
    environment(database),
  ));
  assert.equal(conflict.status, 403);
  assert.match(conflict.body.error, /another device/);
});

test("v2 sync retries idempotently and an empty snapshot clears its whole window", async () => {
  const database = new MemoryD1();
  const deviceId = "019fa6c8-7519-7ba0-9145-b2bf35fec810";
  const first = atomicSyncPayload(
    deviceId,
    1,
    "019fa6c8-7519-7ba0-9145-b2bf35fec811",
    [
      {
        date: "2026-07-28",
        source: "codex",
        model: "gpt-5.6-sol",
        requests: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 0,
        costPicos: "100",
        dataThrough: "2026-07-28T01:00:00Z",
      },
    ],
  );
  const accepted = await responseJson(await worker.fetch(
    request("/v1/sync", { token: MASTER_KEY, body: first }),
    environment(database),
  ));
  assert.equal(accepted.status, 200);
  assert.equal(database.dailyUsage.size, 1);

  const retry = await responseJson(await worker.fetch(
    request("/v1/sync", { token: MASTER_KEY, body: first }),
    environment(database),
  ));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(database.syncRuns.length, 1);

  const conflict = await responseJson(await worker.fetch(
    request("/v1/sync", {
      token: MASTER_KEY,
      body: atomicSyncPayload(
        deviceId,
        1,
        "019fa6c8-7519-7ba0-9145-b2bf35fec812",
      ),
    }),
    environment(database),
  ));
  assert.equal(conflict.status, 409);

  const cleared = await responseJson(await worker.fetch(
    request("/v1/sync", {
      token: MASTER_KEY,
      body: atomicSyncPayload(
        deviceId,
        2,
        "019fa6c8-7519-7ba0-9145-b2bf35fec813",
      ),
    }),
    environment(database),
  ));
  assert.equal(cleared.status, 200);
  assert.equal(database.dailyUsage.size, 0);
  assert.equal(database.syncRuns.length, 2);
});

test("v2 sync cannot let a stale request overwrite a concurrently accepted sequence", async () => {
  const database = new MemoryD1();
  const deviceId = "019fa6c8-7519-7ba0-9145-b2bf35fec814";
  const original = atomicSyncPayload(
    deviceId,
    1,
    "019fa6c8-7519-7ba0-9145-b2bf35fec815",
    [
      {
        date: "2026-07-28",
        source: "codex",
        model: "gpt-5.6-sol",
        requests: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 0,
        costPicos: "100",
        dataThrough: "2026-07-28T01:00:00Z",
      },
    ],
  );
  assert.equal((await responseJson(await worker.fetch(
    request("/v1/sync", { token: MASTER_KEY, body: original }),
    environment(database),
  ))).status, 200);

  database.beforeBatch = async () => {
    database.devices.get(deviceId).lastSequence = 3;
    const key = JSON.stringify([deviceId, "2026-07-28", "codex", "gpt-5.6-sol"]);
    database.dailyUsage.set(key, {
      deviceId,
      date: "2026-07-28",
      source: "codex",
      model: "gpt-5.6-sol",
      requests: 99,
      sequence: 3,
    });
  };
  const stale = await responseJson(await worker.fetch(
    request("/v1/sync", {
      token: MASTER_KEY,
      body: atomicSyncPayload(
        deviceId,
        2,
        "019fa6c8-7519-7ba0-9145-b2bf35fec816",
      ),
    }),
    environment(database),
  ));
  assert.equal(stale.status, 409);
  assert.equal([...database.dailyUsage.values()][0].requests, 99);
  assert.equal(database.syncRuns.some((run) => run.sequence === 2), false);
});

test("GitHub OAuth verifies the immutable account id and issues an already-bound device token", async (t) => {
  const database = new MemoryD1();
  const deviceId = "019fa6c8-7519-7ba0-9145-b2bf35fec820";
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/login/oauth/access_token")) {
      assert.match(String(options.body), /code_verifier=/);
      return new Response(JSON.stringify({ access_token: "github-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url) === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 181867828, login: "KKKK1723" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("/applications/test-client-id/token")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const config = await responseJson(await worker.fetch(
    request("/v1/oauth/github/config", { method: "GET" }),
    environment(database),
  ));
  assert.equal(config.status, 200);
  assert.equal(config.body.clientId, "test-client-id");

  const exchanged = await responseJson(await worker.fetch(
    request("/v1/oauth/github/exchange", {
      body: {
        code: "temporary-code",
        codeVerifier: "a".repeat(43),
        redirectUri: "http://127.0.0.1:49152/oauth/callback",
        deviceId,
        deviceName: "new laptop",
      },
    }),
    environment(database),
  ));
  assert.equal(exchanged.status, 200);
  assert.match(exchanged.body.deviceToken, /^atdt_[A-Za-z0-9_-]{43}$/);
  assert.equal(exchanged.body.github.id, 181867828);
  assert.equal([...database.credentials.values()][0].deviceId, deviceId);
  assert.equal(calls.some((call) => call.options.method === "DELETE"), true);
  assert.equal(
    [...database.credentials.keys()].includes(exchanged.body.deviceToken),
    false,
  );
});

test("GitHub OAuth does not issue a device credential before token revocation succeeds", async (t) => {
  const database = new MemoryD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/login/oauth/access_token")) {
      return Response.json({ access_token: "github-access-token" });
    }
    if (String(url) === "https://api.github.com/user") {
      return Response.json({ id: 181867828, login: "KKKK1723" });
    }
    if (String(url).includes("/applications/test-client-id/token")) {
      return new Response(null, { status: 500 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const exchanged = await responseJson(await worker.fetch(
    request("/v1/oauth/github/exchange", {
      body: {
        code: "temporary-code",
        codeVerifier: "a".repeat(43),
        redirectUri: "http://127.0.0.1:49152/oauth/callback",
        deviceId: "019fa6c8-7519-7ba0-9145-b2bf35fec821",
        deviceName: "new laptop",
      },
    }),
    environment(database),
  ));
  assert.equal(exchanged.status, 502);
  assert.equal(database.credentials.size, 0);
});

test("GitHub OAuth rejects and revokes an access token with inherited scopes", async (t) => {
  const database = new MemoryD1();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/login/oauth/access_token")) {
      return Response.json({
        access_token: "github-access-token",
        scope: "repo",
      });
    }
    if (String(url).includes("/applications/test-client-id/token")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const exchanged = await responseJson(await worker.fetch(
    request("/v1/oauth/github/exchange", {
      body: {
        code: "temporary-code",
        codeVerifier: "a".repeat(43),
        redirectUri: "http://127.0.0.1:49152/oauth/callback",
        deviceId: "019fa6c8-7519-7ba0-9145-b2bf35fec822",
        deviceName: "new laptop",
      },
    }),
    environment(database),
  ));
  assert.equal(exchanged.status, 403);
  assert.match(exchanged.body.error, /unexpected scopes/);
  assert.equal(database.credentials.size, 0);
  assert.equal(calls.some((call) => call.options.method === "DELETE"), true);
});
