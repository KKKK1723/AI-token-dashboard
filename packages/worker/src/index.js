import { summarizeRows, summaryDateRange, validateSyncPayload } from "./core.js";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function authorized(request, expected) {
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function syncUsage(request, env) {
  if (!authorized(request, env.SYNC_KEY)) return json({ error: "unauthorized" }, 401);
  let payload;
  try {
    payload = validateSyncPayload(await request.json());
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const accountTimezone = env.DASHBOARD_TIMEZONE || "Asia/Shanghai";
  if (payload.timezone !== accountTimezone) {
    return json({ error: `timezone must be ${accountTimezone}` }, 400);
  }
  const now = new Date().toISOString();
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
  if (!authorized(request, env.READ_KEY)) return json({ error: "unauthorized" }, 401);
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
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "ai-token-dashboard" });
    }
    if (request.method === "POST" && url.pathname === "/v1/sync") {
      return syncUsage(request, env);
    }
    if (request.method === "GET" && url.pathname === "/v1/summary") {
      return getSummary(request, env);
    }
    return json({ error: "not found" }, 404);
  },
};
