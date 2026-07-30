import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main, normalizeApiUrl } from "../src/main.js";
import { createEmptyState, validateState } from "../src/storage.js";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-token-dashboard-main-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("production sync URLs require HTTPS", () => {
  assert.equal(normalizeApiUrl("https://usage.example.test/"), "https://usage.example.test");
  assert.equal(normalizeApiUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(
    () => normalizeApiUrl("http://usage.example.test"),
    /must use HTTPS/,
  );
  assert.throws(
    () => normalizeApiUrl("https://user:secret@usage.example.test"),
    /cannot contain credentials/,
  );
});

test("legacy local state schedules one catch-up sync", () => {
  const state = createEmptyState();
  delete state.pendingSync;
  delete state.needsSync;
  const validated = validateState(state);
  assert.equal(validated.pendingSync, null);
  assert.equal(validated.needsSync, true);
});

test("local pending sync sequence cannot regress confirmed data", () => {
  const state = createEmptyState();
  state.syncSequence = 4;
  state.pendingSync = { payload: { sequence: 4 } };
  assert.throws(() => validateState(state), /sequence is inconsistent/);
});

test("daily sync uploads usage already collected by the minute task", async (t) => {
  const root = await temporaryDirectory(t);
  const dataDirectory = path.join(root, "data");
  const claudeDirectory = path.join(root, "claude");
  const codexDirectory = path.join(root, "codex");
  const sessions = path.join(codexDirectory, "sessions", "2026", "07", "30");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.mkdir(claudeDirectory, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });

  const thread = "019fa6c8-7519-7ba0-9145-b2bf35fec800";
  const timestamp = new Date().toISOString();
  const events = [
    { timestamp, type: "session_meta", payload: { id: thread } },
    { timestamp, type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 10,
          },
        },
      },
    },
  ];
  await fs.writeFile(
    path.join(sessions, `rollout-2026-07-30T00-00-00-${thread}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  const config = {
    schemaVersion: 1,
    apiUrl: "http://127.0.0.1:8787",
    syncKey: { kind: "file", value: "test-key" },
    credentialType: "master",
    deviceId: "test-device",
    deviceName: "Test device",
    timezone: "Asia/Shanghai",
    uploadDays: 45,
    pricingOverrides: {},
    sources: { claude: claudeDirectory, codex: codexDirectory },
  };
  const state = createEmptyState();
  state.syncSequence = 1;
  await fs.writeFile(path.join(dataDirectory, "config.json"), JSON.stringify(config), "utf8");
  await fs.writeFile(path.join(dataDirectory, "state.json"), JSON.stringify(state), "utf8");

  const previousHome = process.env.AI_TOKEN_DASHBOARD_HOME;
  const previousFetch = globalThis.fetch;
  process.env.AI_TOKEN_DASHBOARD_HOME = dataDirectory;
  let uploadedPayload = null;
  globalThis.fetch = async (_url, options) => {
    uploadedPayload = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  t.after(() => {
    if (previousHome === undefined) delete process.env.AI_TOKEN_DASHBOARD_HOME;
    else process.env.AI_TOKEN_DASHBOARD_HOME = previousHome;
    globalThis.fetch = previousFetch;
  });

  assert.equal(await main(["collect"]), 0);
  let saved = JSON.parse(await fs.readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(saved.needsSync, true);

  assert.equal(await main(["sync"]), 0);
  assert.equal(uploadedPayload.sequence, 2);
  saved = JSON.parse(await fs.readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(saved.needsSync, false);
  assert.equal(saved.syncSequence, 2);
});
