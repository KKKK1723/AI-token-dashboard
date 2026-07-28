const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,31}$/;
const DECIMAL_INTEGER = /^\d+$/;

function requireNonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer.`);
  }
  return value;
}

function requireText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

export function validateSyncPayload(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("Unsupported sync schema version.");
  if (!UUID.test(value.deviceId || "")) throw new Error("deviceId must be a UUID.");
  requireText(value.deviceName, "deviceName", 120);
  requireText(value.timezone, "timezone", 80);
  requireText(value.collectorVersion, "collectorVersion", 40);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new Error("sequence must be a positive safe integer.");
  }
  if (!Array.isArray(value.buckets) || value.buckets.length > 1000) {
    throw new Error("buckets must be an array with at most 1000 entries.");
  }
  const keys = new Set();
  const buckets = value.buckets.map((bucket, index) => {
    if (!DATE.test(bucket.date || "")) throw new Error(`buckets[${index}].date is invalid.`);
    if (!SOURCE.test(bucket.source || "")) throw new Error(`buckets[${index}].source is invalid.`);
    requireText(bucket.model, `buckets[${index}].model`, 160);
    if (!DECIMAL_INTEGER.test(String(bucket.costPicos ?? ""))) {
      throw new Error(`buckets[${index}].costPicos must be an unsigned integer string.`);
    }
    if (bucket.dataThrough != null && Number.isNaN(Date.parse(bucket.dataThrough))) {
      throw new Error(`buckets[${index}].dataThrough is invalid.`);
    }
    const normalized = {
      date: bucket.date,
      source: bucket.source,
      model: bucket.model,
      requests: requireNonnegativeInteger(bucket.requests, `buckets[${index}].requests`),
      inputTokens: requireNonnegativeInteger(bucket.inputTokens, `buckets[${index}].inputTokens`),
      outputTokens: requireNonnegativeInteger(bucket.outputTokens, `buckets[${index}].outputTokens`),
      cacheReadTokens: requireNonnegativeInteger(bucket.cacheReadTokens, `buckets[${index}].cacheReadTokens`),
      cacheCreationTokens: requireNonnegativeInteger(bucket.cacheCreationTokens, `buckets[${index}].cacheCreationTokens`),
      costPicos: String(bucket.costPicos),
      dataThrough: bucket.dataThrough || null,
    };
    const key = JSON.stringify([normalized.date, normalized.source, normalized.model]);
    if (keys.has(key)) throw new Error(`Duplicate bucket: ${key}`);
    keys.add(key);
    return normalized;
  });
  return {
    schemaVersion: 1,
    deviceId: value.deviceId.toLowerCase(),
    deviceName: value.deviceName,
    timezone: value.timezone,
    collectorVersion: value.collectorVersion,
    sequence: value.sequence,
    buckets,
  };
}

function dateInTimezone(date, timezone) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateText, amount) {
  const value = new Date(`${dateText}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function summaryDateRange(now, timezone, days) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be between 1 and 90.");
  const end = dateInTimezone(now, timezone);
  return { start: addDays(end, -(days - 1)), end };
}

function emptyUsage() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costPicos: 0n,
  };
}

function addRow(target, row) {
  target.requests += Number(row.requests);
  target.inputTokens += Number(row.input_tokens);
  target.outputTokens += Number(row.output_tokens);
  target.cacheReadTokens += Number(row.cache_read_tokens);
  target.cacheCreationTokens += Number(row.cache_creation_tokens);
  target.costPicos += BigInt(row.cost_picos);
}

function picosToUsd(picos) {
  const scale = 1_000_000_000_000n;
  const whole = picos / scale;
  const fraction = (picos % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function summarizeRows(rows, { start, end, generatedAt }) {
  const totals = emptyUsage();
  const models = new Map();
  let dataThrough = null;
  for (const row of rows) {
    addRow(totals, row);
    if (!models.has(row.model)) models.set(row.model, emptyUsage());
    addRow(models.get(row.model), row);
    if (row.data_through && (!dataThrough || row.data_through > dataThrough)) {
      dataThrough = row.data_through;
    }
  }
  const normalize = (name, usage) => ({
    ...(name == null ? {} : { name }),
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: picosToUsd(usage.costPicos),
    totalTokens:
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens,
  });
  return {
    schemaVersion: 1,
    windowStartDate: start,
    windowEndDate: end,
    generatedAt: generatedAt.toISOString(),
    dataThrough,
    ...normalize(null, totals),
    models: [...models.entries()]
      .map(([name, usage]) => normalize(name, usage))
      .sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests || left.name.localeCompare(right.name)),
  };
}
