import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reconcileUsage } from "../src/reconciliation.js";
import { createEmptyState } from "../src/storage.js";

const NOW = new Date("2026-08-16T12:00:00+08:00");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ai-token-dashboard-reconciliation-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const root = await temporaryDirectory(t);
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  const project = path.join(claude, "projects", "sample");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(codex, { recursive: true });
  const event = {
    type: "assistant",
    timestamp: "2026-08-16T03:00:00Z",
    message: {
      id: "msg-reconcile",
      model: "claude-opus-4-8",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    },
  };
  await fs.writeFile(
    path.join(project, "session.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
  return {
    config: {
      timezone: "Asia/Shanghai",
      uploadDays: 45,
      pricingOverrides: {},
      sources: { claude, codex },
    },
    claude,
  };
}

test("reconciliation detects and repairs a recent incremental mismatch", async (t) => {
  const { config } = await fixture(t);
  const state = createEmptyState();

  const detected = await reconcileUsage(config, state, {
    days: 7,
    repair: false,
    now: NOW,
  });
  assert.equal(detected.mismatch, true);
  assert.equal(detected.repaired, false);
  assert.equal(detected.trustworthy, true);
  assert.equal(state.diagnostics.lastReconciliation.status, "mismatch");

  const repaired = await reconcileUsage(config, state, {
    days: 7,
    repair: true,
    now: NOW,
  });
  assert.equal(repaired.mismatch, true);
  assert.equal(repaired.repaired, true);
  assert.equal(state.records["session:msg-reconcile"].outputTokens, 20);
  assert.equal(state.needsSync, true);
  assert.equal(state.diagnostics.lastReconciliation.status, "ok");
});

test("reconciliation preserves recent records when their source directory disappears", async (t) => {
  const { config, claude } = await fixture(t);
  const state = createEmptyState();
  state.records["session:existing"] = {
    date: "2026-08-16",
    source: "claude",
    model: "claude-opus-4-8",
    requests: 1,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
    costPicos: "5",
    dataThrough: "2026-08-16T03:00:00Z",
  };
  await fs.rename(claude, `${claude}-offline`);

  const result = await reconcileUsage(config, state, {
    days: 7,
    repair: true,
    now: NOW,
  });
  assert.equal(result.mismatch, false);
  assert.equal(result.repaired, false);
  assert.equal(result.trustworthy, false);
  assert.equal(result.sourceAvailability.claude, false);
  assert.ok(state.records["session:existing"]);
  assert.equal(state.diagnostics.lastReconciliation.status, "degraded");
  assert.match(state.diagnostics.issues[0], /Cannot reconcile claude/);
});

test("degraded full-scan diagnostics never report a healthy reconciliation", async (t) => {
  const { config } = await fixture(t);
  const sessions = path.join(config.sources.codex, "sessions", "2026", "08", "16");
  await fs.mkdir(sessions, { recursive: true });
  const thread = "01a00897-0074-7ac1-9bec-e6fc13bc4769";
  await fs.writeFile(
    path.join(sessions, `rollout-2026-08-16T00-00-00-${thread}.jsonl`),
    [
      JSON.stringify({
        timestamp: "2026-08-16T03:00:00Z",
        type: "session_meta",
        payload: { id: thread },
      }),
      JSON.stringify({
        timestamp: "2026-08-16T03:00:01Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { future_token_usage: { tokens: 10 } },
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const state = createEmptyState();
  const result = await reconcileUsage(config, state, {
    days: 7,
    repair: true,
    now: NOW,
  });
  assert.equal(result.mismatch, true);
  assert.equal(result.repaired, false);
  assert.equal(result.trustworthy, false);
  assert.equal(state.diagnostics.lastReconciliation.status, "degraded");
});
