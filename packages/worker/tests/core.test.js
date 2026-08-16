import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRows, summaryDateRange, validateSyncPayload } from "../src/core.js";

function payload() {
  return {
    schemaVersion: 1,
    deviceId: "019fa6c8-7519-7ba0-9145-b2bf35fec800",
    deviceName: "desktop",
    timezone: "Asia/Shanghai",
    collectorVersion: "2.0.0",
    sequence: 3,
    buckets: [
      {
        date: "2026-07-28",
        source: "codex",
        model: "gpt-5.6-sol",
        requests: 2,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 0,
        costPicos: "125000000000",
        dataThrough: "2026-07-28T01:00:00Z",
      },
    ],
  };
}

test("sync payload validation rejects duplicate absolute buckets", () => {
  const value = payload();
  value.buckets.push({ ...value.buckets[0] });
  assert.throws(() => validateSyncPayload(value), /Duplicate bucket/);
});

test("v2 sync payload requires a bounded window and keeps every bucket inside it", () => {
  const value = {
    ...payload(),
    schemaVersion: 2,
    snapshotId: "019fa6c8-7519-7ba0-9145-b2bf35fec801",
    windowStartDate: "2026-07-01",
    windowEndDate: "2026-07-31",
  };
  assert.equal(validateSyncPayload(value).schemaVersion, 2);
  value.buckets[0].date = "2026-08-01";
  assert.throws(() => validateSyncPayload(value), /inside the sync window/);
  value.buckets[0].date = "2026-07-28";
  value.windowEndDate = "2026-02-31";
  assert.throws(() => validateSyncPayload(value), /window dates are invalid/);
});

test("summary adds rows from different devices exactly once", () => {
  const rows = [
    {
      model: "gpt-5.6-sol",
      requests: 2,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_creation_tokens: 0,
      cost_picos: "125000000000",
      data_through: "2026-07-28T01:00:00Z",
    },
    {
      model: "gpt-5.6-sol",
      requests: 1,
      input_tokens: 5,
      output_tokens: 10,
      cache_read_tokens: 15,
      cache_creation_tokens: 0,
      cost_picos: "62500000000",
      data_through: "2026-07-28T02:00:00Z",
    },
  ];
  const summary = summarizeRows(rows, {
    start: "2026-06-29",
    end: "2026-07-28",
    generatedAt: new Date("2026-07-28T03:00:00Z"),
  });
  assert.equal(summary.requests, 3);
  assert.equal(summary.totalTokens, 90);
  assert.equal(summary.costUsd, "0.1875");
  assert.equal(summary.models[0].requests, 3);
  assert.equal(summary.dataThrough, "2026-07-28T02:00:00Z");
});

test("30-day date range uses the configured account timezone", () => {
  assert.deepEqual(
    summaryDateRange(new Date("2026-07-28T16:30:00Z"), "Asia/Shanghai", 30),
    { start: "2026-06-30", end: "2026-07-29" },
  );
});
