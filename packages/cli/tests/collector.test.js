import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claudeInternals, collectClaudeUsage } from "../src/collectors/claude.js";
import { codexInternals, collectCodexUsage, normalizeCodexModel } from "../src/collectors/codex.js";
import { createPricingCatalog, calculateCostPicos, findPricing } from "../src/pricing.js";
import { aggregateDailyBuckets, importSeed, pruneLocalHistory } from "../src/records.js";
import { createEmptyState } from "../src/storage.js";

const pricingCatalog = createPricingCatalog();

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-dashboard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("pricing matches CC Switch cache semantics and aliases", () => {
  const pricing = findPricing(pricingCatalog, "OpenAI/GPT-5.5@HIGH");
  assert.equal(pricing.input, "5");
  assert.equal(pricing.output, "30");
  const result = calculateCostPicos(
    {
      model: "gpt-5.6-sol",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheCreationTokens: 20,
    },
    pricingCatalog,
  );
  assert.equal(result.costPicos, "2525000000");
});

test("Claude replacement rule mirrors CC Switch", () => {
  assert.equal(
    claudeInternals.shouldReplaceClaudeUsage(
      { stopReason: null, outputTokens: 100 },
      { stopReason: "tool_use", outputTokens: 80 },
    ),
    true,
  );
  assert.equal(
    claudeInternals.shouldReplaceClaudeUsage(
      { stopReason: "tool_use", outputTokens: 100 },
      { stopReason: null, outputTokens: 200 },
    ),
    false,
  );
});

test("Claude collector replaces a partial message with its completed snapshot", async (t) => {
  const root = await temporaryDirectory(t);
  const project = path.join(root, "projects", "sample");
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, "session.jsonl");
  const base = {
    type: "assistant",
    timestamp: "2026-07-28T01:00:00Z",
    message: {
      id: "msg-1",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    },
  };
  await fs.writeFile(file, `${JSON.stringify(base)}\n`, "utf8");
  const state = createEmptyState();
  const first = await collectClaudeUsage({ state, claudeDirectory: root, timezone: "Asia/Shanghai", pricingCatalog });
  assert.equal(first.imported, 1);

  base.message.stop_reason = "end_turn";
  base.message.usage.output_tokens = 100;
  await fs.appendFile(file, `${JSON.stringify(base)}\n`, "utf8");
  const second = await collectClaudeUsage({ state, claudeDirectory: root, timezone: "Asia/Shanghai", pricingCatalog });
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  assert.equal(state.records["session:msg-1"].outputTokens, 100);
  assert.equal(state.records["session:msg-1"].stopReason, "end_turn");
});

test("Codex collector computes cumulative deltas and fresh input", async (t) => {
  const root = await temporaryDirectory(t);
  const sessions = path.join(root, "sessions", "2026", "07", "28");
  await fs.mkdir(sessions, { recursive: true });
  const thread = "019fa6c8-7519-7ba0-9145-b2bf35fec800";
  const file = path.join(sessions, `rollout-2026-07-28T00-00-00-${thread}.jsonl`);
  const values = [
    { timestamp: "2026-07-28T00:00:00Z", type: "session_meta", payload: { id: thread } },
    { timestamp: "2026-07-28T00:00:01Z", type: "turn_context", payload: { model: "OpenAI/GPT-5.6-SOL" } },
    {
      timestamp: "2026-07-28T00:00:02Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } },
    },
    {
      timestamp: "2026-07-28T00:00:03Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 15 } } },
    },
  ];
  await fs.writeFile(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  const state = createEmptyState();
  const result = await collectCodexUsage({ state, codexDirectory: root, timezone: "Asia/Shanghai", pricingCatalog });
  assert.equal(result.imported, 2);
  const buckets = aggregateDailyBuckets(state, { start: "2026-07-28", end: "2026-07-28" });
  assert.equal(buckets[0].requests, 2);
  assert.equal(buckets[0].inputTokens, 50);
  assert.equal(buckets[0].cacheReadTokens, 100);
  assert.equal(buckets[0].outputTokens, 15);
  assert.equal(buckets[0].model, "gpt-5.6-sol");
});

test("Codex replay matching and model normalization are deterministic", () => {
  assert.equal(normalizeCodexModel("azure/GPT-5.4-2026-03-05"), "gpt-5.4");
  assert.equal(
    codexInternals.matchingReplayPrefix(
      [{ signature: "b" }, { signature: "d" }, { signature: "x" }],
      ["a", "b", "c", "d", "e"],
    ),
    2,
  );
});

test("Codex collector treats decreasing cumulative counters as a reset and keeps quota as a snapshot", async (t) => {
  const root = await temporaryDirectory(t);
  const sessions = path.join(root, "sessions", "2026", "07", "28");
  await fs.mkdir(sessions, { recursive: true });
  const thread = "019fa6c8-7519-7ba0-9145-b2bf35fec801";
  const file = path.join(sessions, `rollout-2026-07-28T00-00-00-${thread}.jsonl`);
  const rateLimits = {
    limit_id: "codex",
    primary: { used_percent: 12, window_minutes: 300, resets_at: 1785200000 },
    secondary: { used_percent: 34, window_minutes: 10080, resets_at: 1785800000 },
  };
  const values = [
    { timestamp: "2026-07-28T00:00:00Z", type: "session_meta", payload: { id: thread } },
    { timestamp: "2026-07-28T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    {
      timestamp: "2026-07-28T00:00:02Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } },
        rate_limits: rateLimits,
      },
    },
    {
      timestamp: "2026-07-28T00:00:03Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 } },
        rate_limits: rateLimits,
      },
    },
  ];
  await fs.writeFile(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  const state = createEmptyState();
  const result = await collectCodexUsage({ state, codexDirectory: root, timezone: "Asia/Shanghai", pricingCatalog });
  assert.equal(result.imported, 2);
  assert.equal(result.counterResets, 1);
  assert.equal(result.quotaUpdated, true);
  assert.equal(state.quotaSnapshots.codex.observedAt, "2026-07-28T00:00:03.000Z");
  assert.deepEqual(state.quotaSnapshots.codex.rateLimits, rateLimits);
  const [bucket] = aggregateDailyBuckets(state, { start: "2026-07-28", end: "2026-07-28" });
  assert.equal(bucket.inputTokens, 35);
  assert.equal(bucket.cacheReadTokens, 85);
  assert.equal(bucket.outputTokens, 12);
});

test("Codex collector separates cache writes from cache-inclusive input", async (t) => {
  const root = await temporaryDirectory(t);
  const sessions = path.join(root, "sessions", "2026", "07", "28");
  await fs.mkdir(sessions, { recursive: true });
  const thread = "019fa6c8-7519-7ba0-9145-b2bf35fec803";
  const file = path.join(sessions, `rollout-2026-07-28T00-00-00-${thread}.jsonl`);
  const values = [
    { timestamp: "2026-07-28T00:00:00Z", type: "session_meta", payload: { id: thread } },
    { timestamp: "2026-07-28T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    {
      timestamp: "2026-07-28T00:00:02Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 30,
            cache_write_input_tokens: 20,
            output_tokens: 10,
          },
        },
      },
    },
    {
      timestamp: "2026-07-28T00:00:03Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 180,
            cached_input_tokens: 50,
            cache_write_input_tokens: 50,
            output_tokens: 20,
          },
        },
      },
    },
  ];
  await fs.writeFile(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  const state = createEmptyState();
  const result = await collectCodexUsage({
    state,
    codexDirectory: root,
    timezone: "Asia/Shanghai",
    pricingCatalog,
  });
  assert.equal(result.imported, 2);
  assert.equal(result.counterAnomalies, 0);
  const [bucket] = aggregateDailyBuckets(state, {
    start: "2026-07-28",
    end: "2026-07-28",
  });
  assert.equal(bucket.inputTokens, 80);
  assert.equal(bucket.cacheReadTokens, 50);
  assert.equal(bucket.cacheCreationTokens, 50);
  assert.equal(bucket.outputTokens, 20);
});

test("Codex parser reports unsupported token schemas instead of counting zero", () => {
  const parsed = codexInternals.parseCodexText(
    [
      JSON.stringify({
        timestamp: "2026-07-28T00:00:00Z",
        type: "session_meta",
        payload: { id: "019fa6c8-7519-7ba0-9145-b2bf35fec802" },
      }),
      JSON.stringify({
        timestamp: "2026-07-28T00:00:01Z",
        type: "event_msg",
        payload: { type: "token_count", info: { future_token_usage: { tokens: 10 } } },
      }),
    ].join("\n"),
    "019fa6c8-7519-7ba0-9145-b2bf35fec802",
  );
  assert.equal(parsed.unsupportedEvents, 1);
  assert.equal(parsed.hasBillableTokens, false);
});

test("migration seed and native records share an absolute daily bucket", () => {
  const state = createEmptyState();
  importSeed(state, {
    schemaVersion: 1,
    cutoffAt: "2026-07-28T00:00:00Z",
    buckets: [
      {
        date: "2026-07-28",
        source: "claude",
        model: "claude-opus-4-8",
        requests: 2,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        costPicos: "100",
        dataThrough: "2026-07-28T00:00:00Z",
      },
    ],
  });
  state.records.later = {
    date: "2026-07-28",
    source: "claude",
    model: "claude-opus-4-8",
    requests: 1,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
    costPicos: "10",
    dataThrough: "2026-07-28T01:00:00Z",
  };
  const [bucket] = aggregateDailyBuckets(state, { start: "2026-07-28", end: "2026-07-28" });
  assert.equal(bucket.requests, 3);
  assert.equal(bucket.outputTokens, 22);
  assert.equal(bucket.costPicos, "110");
});

test("confirmed sync pruning retains only the upload window", () => {
  const state = createEmptyState();
  state.records.old = { date: "2026-06-01" };
  state.records.current = { date: "2026-07-28" };
  state.seedBuckets.old = { date: "2026-06-01" };
  state.seedBuckets.current = { date: "2026-07-28" };
  pruneLocalHistory(state, "2026-06-15");
  assert.deepEqual(Object.keys(state.records), ["current"]);
  assert.deepEqual(Object.keys(state.seedBuckets), ["current"]);
});
