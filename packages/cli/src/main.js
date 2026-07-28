import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { uploadUsage } from "./api.js";
import { collectUsage } from "./collector.js";
import { protectSecret, revealSecret } from "./credentials.js";
import { dashboardPaths, defaultClaudeDirectory, defaultCodexDirectory } from "./paths.js";
import { importSeed, pruneLocalHistory } from "./records.js";
import { installSchedule, removeSchedule } from "./scheduler.js";
import { appendLog, createEmptyState, readJson, validateState, withFileLock, writeJsonAtomic } from "./storage.js";

const VERSION = "2.0.0";

function parseOptions(args) {
  const options = { _: [] };
  const booleanOptions = new Set(["no-schedule", "no-sync", "new-device"]);
  const valueOptions = new Set(["api-url", "key", "seed", "timezone", "device-name", "at"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error("Unexpected argument: " + argument);
    }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }
    if (!valueOptions.has(name)) throw new Error("Unknown option: --" + name);
    const value = args[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function help() {
  return `AI token dashboard ${VERSION}

Usage:
  ai-token-dashboard init --api-url <url> --key <sync-key> [--seed <file>]
  ai-token-dashboard collect
  ai-token-dashboard sync
  ai-token-dashboard status
  ai-token-dashboard uninstall

Options:
  --timezone <iana>     Account timezone (default: Asia/Shanghai)
  --device-name <name>  Friendly device label
  --at <HH:mm>          Daily sync time (default: 03:10)
  --seed <file>         One-time CCSwitch migration seed
  --new-device          Generate a replacement device identity
  --no-schedule         Do not install the operating-system timer
  --no-sync             Configure without performing the first upload
`;
}

async function loadConfigured(paths) {
  const config = await readJson(paths.config);
  if (!config) throw new Error("Dashboard is not initialized. Run 'ai-token-dashboard init'.");
  const state = validateState((await readJson(paths.state)) || createEmptyState());
  return { config, state };
}

export function normalizeApiUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--api-url must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("--api-url must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("--api-url cannot contain credentials, a query, or a fragment.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (parsed.protocol !== "https:" && !loopback.has(parsed.hostname)) {
    throw new Error("--api-url must use HTTPS except for a localhost Worker.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function collectionSummary(collection) {
  return {
    imported: collection.results.reduce((sum, result) => sum + result.imported, 0),
    unknownModels: collection.unknownModels,
  };
}

async function uploadPending(paths, config, state) {
  const pending = state.pendingSync;
  if (!pending?.payload) throw new Error("Local pending sync state is invalid.");
  const response = await uploadUsage({
    apiUrl: config.apiUrl,
    key: revealSecret(config.syncKey),
    payload: pending.payload,
  });
  state.syncSequence = pending.payload.sequence;
  state.lastSyncAt = new Date().toISOString();
  state.lastSyncBuckets = pending.payload.buckets.length;
  state.pendingSync = null;
  if (pending.retainFrom) pruneLocalHistory(state, pending.retainFrom);
  await writeJsonAtomic(paths.state, state);
  const message =
    `Synced ${pending.payload.buckets.length} daily model buckets at sequence ${pending.payload.sequence}; ` +
    `imported ${pending.imported || 0} new request records.`;
  await appendLog(paths.log, message);
  for (const model of pending.unknownModels || []) {
    await appendLog(paths.log, `Model without a price (cost remains $0): ${model}`);
  }
  console.log(message);
  return response;
}

async function collectLocal(paths) {
  return withFileLock(paths.lock, async () => {
    const { config, state } = await loadConfigured(paths);
    const collection = await collectUsage(config, state);
    const summary = collectionSummary(collection);
    if (collection.changed) await writeJsonAtomic(paths.state, state);
    const message =
      `Collected ${summary.imported} new request records from ` +
      `${collection.results.reduce((sum, result) => sum + result.changedFiles, 0)} changed files.`;
    if (collection.changed) await appendLog(paths.log, message);
    for (const model of summary.unknownModels) {
      await appendLog(paths.log, `Model without a price (cost remains $0): ${model}`);
    }
    console.log(message);
  });
}

async function sync(paths) {
  return withFileLock(paths.lock, async () => {
    const { config, state } = await loadConfigured(paths);
    let response = null;
    if (state.pendingSync) response = await uploadPending(paths, config, state);

    const collection = await collectUsage(config, state);
    const summary = collectionSummary(collection);
    if (!collection.changed && state.syncSequence > 0) {
      console.log("No new local usage to sync.");
      return response;
    }
    const sequence = state.syncSequence + 1;
    const payload = {
      schemaVersion: 1,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      timezone: config.timezone,
      collectorVersion: VERSION,
      sequence,
      buckets: collection.buckets,
    };
    state.pendingSync = {
      payload,
      imported: summary.imported,
      unknownModels: summary.unknownModels,
      retainFrom: collection.range.start,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(paths.state, state);
    return uploadPending(paths, config, state);
  }, { waitMs: 60_000 });
}

async function initialize(paths, options) {
  const existing = await readJson(paths.config);
  const apiUrlValue = options["api-url"] || existing?.apiUrl;
  const rawKey = options.key || process.env.AI_TOKEN_DASHBOARD_KEY;
  if (!apiUrlValue) throw new Error("--api-url is required.");
  const apiUrl = normalizeApiUrl(apiUrlValue);
  if (!rawKey && !existing?.syncKey) throw new Error("--key or AI_TOKEN_DASHBOARD_KEY is required.");
  const timezone = options.timezone || existing?.timezone || "Asia/Shanghai";
  const config = {
    schemaVersion: 1,
    apiUrl,
    syncKey: rawKey ? protectSecret(rawKey) : existing.syncKey,
    deviceId: options["new-device"] || !existing?.deviceId ? randomUUID() : existing.deviceId,
    deviceName: options["device-name"] || existing?.deviceName || os.hostname(),
    timezone,
    uploadDays: 45,
    pricingOverrides: existing?.pricingOverrides || {},
    sources: {
      claude: existing?.sources?.claude || defaultClaudeDirectory(),
      codex: existing?.sources?.codex || defaultCodexDirectory(),
    },
  };
  const state = options["new-device"] ? createEmptyState() : validateState((await readJson(paths.state)) || createEmptyState());
  if (options.seed) {
    const seed = JSON.parse(await fs.readFile(path.resolve(options.seed), "utf8"));
    if (seed.timezone !== timezone) {
      throw new Error("Migration seed timezone must be " + timezone + ".");
    }
    importSeed(state, seed);
  }
  await writeJsonAtomic(paths.config, config);
  await writeJsonAtomic(paths.state, state);
  if (!options["no-schedule"]) {
    await installSchedule({
      nodeExecutable: process.execPath,
      scriptPath: fileURLToPath(new URL("../bin/ai-token-dashboard.js", import.meta.url)),
      at: options.at || "03:10",
    });
    console.log(
      `Installed 60-second local collection and daily sync at ${options.at || "03:10"}.`,
    );
  }
  console.log(`Initialized device ${config.deviceName} (${config.deviceId}).`);
  if (!options["no-sync"]) await sync(paths);
}

async function status(paths) {
  const { config, state } = await loadConfigured(paths);
  console.log(JSON.stringify({
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    apiUrl: config.apiUrl,
    timezone: config.timezone,
    lastSyncAt: state.lastSyncAt || null,
    syncSequence: state.syncSequence,
    trackedRecords: Object.keys(state.records).length,
    seedBuckets: Object.keys(state.seedBuckets).length,
    cutoffAt: state.cutoffAt,
    pendingSequence: state.pendingSync?.payload?.sequence || null,
  }, null, 2));
}

export async function main(args) {
  const [command = "help", ...rest] = args;
  const paths = dashboardPaths();
  try {
    if (["help", "--help", "-h"].includes(command)) {
      console.log(help());
      return 0;
    }
    if (["version", "--version", "-v"].includes(command)) {
      console.log(VERSION);
      return 0;
    }
    if (command === "init") await initialize(paths, parseOptions(rest));
    else if (command === "collect") await collectLocal(paths);
    else if (command === "sync") await sync(paths);
    else if (command === "status") await status(paths);
    else if (command === "uninstall") {
      await removeSchedule();
      console.log("Removed the local collection and daily sync schedules. Local usage data was retained.");
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
    return 0;
  } catch (error) {
    await appendLog(paths.log, `ERROR: ${error.message}`).catch(() => {});
    console.error(`error: ${error.message}`);
    return 1;
  }
}
