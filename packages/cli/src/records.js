import { calculateCostPicos } from "./pricing.js";

export function recordKey(parts) {
  return JSON.stringify(parts);
}

export function addUsageRecord(state, id, record, pricingCatalog) {
  if (state.records[id]) return { inserted: false, unknownModel: null };
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "requests",
  ]) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
      throw new Error(`Invalid ${field} for ${id}`);
    }
  }
  const cost = calculateCostPicos(record, pricingCatalog);
  state.records[id] = { ...record, costPicos: cost.costPicos };
  return { inserted: true, unknownModel: cost.unknownModel };
}

function emptyBucket(record) {
  return {
    date: record.date,
    source: record.source,
    model: record.model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costPicos: "0",
    dataThrough: null,
  };
}

function mergeBucket(target, source) {
  target.requests += Number(source.requests);
  target.inputTokens += Number(source.inputTokens);
  target.outputTokens += Number(source.outputTokens);
  target.cacheReadTokens += Number(source.cacheReadTokens);
  target.cacheCreationTokens += Number(source.cacheCreationTokens);
  target.costPicos = (BigInt(target.costPicos) + BigInt(source.costPicos)).toString();
  if (source.dataThrough && (!target.dataThrough || source.dataThrough > target.dataThrough)) {
    target.dataThrough = source.dataThrough;
  }
}

export function aggregateDailyBuckets(state, { start, end }) {
  const buckets = new Map();
  const add = (record) => {
    if (record.date < start || record.date > end) return;
    const key = recordKey([record.date, record.source, record.model]);
    if (!buckets.has(key)) buckets.set(key, emptyBucket(record));
    mergeBucket(buckets.get(key), record);
  };
  for (const bucket of Object.values(state.seedBuckets)) add(bucket);
  for (const record of Object.values(state.records)) add(record);
  return [...buckets.values()].sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.source.localeCompare(right.source) ||
      left.model.localeCompare(right.model),
  );
}

export function importSeed(state, seed) {
  if (seed?.schemaVersion !== 1 || !Array.isArray(seed.buckets) || !seed.cutoffAt) {
    throw new Error("Invalid CCSwitch migration seed.");
  }
  for (const bucket of seed.buckets) {
    const key = recordKey([bucket.date, bucket.source, bucket.model]);
    state.seedBuckets[key] = { ...bucket, costPicos: String(bucket.costPicos) };
  }
  state.cutoffAt = seed.cutoffAt;
}

export function pruneLocalHistory(state, retainFrom) {
  for (const [id, record] of Object.entries(state.records)) {
    if (record.date < retainFrom) delete state.records[id];
  }
  for (const [key, bucket] of Object.entries(state.seedBuckets)) {
    if (bucket.date < retainFrom) delete state.seedBuckets[key];
  }
}
