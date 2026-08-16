import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPairingCode, redeemPairingCode, uploadUsage } from "./api.js";
import { collectUsage } from "./collector.js";
import { protectSecret, revealSecret } from "./credentials.js";
import { authorizeGithubDevice } from "./github-oauth.js";
import { decodePairingBundle, encodePairingBundle, validateDeviceToken } from "./pairing.js";
import { dashboardPaths, defaultClaudeDirectory, defaultCodexDirectory } from "./paths.js";
import { importSeed, pruneLocalHistory } from "./records.js";
import { reconcileUsage } from "./reconciliation.js";
import { installSchedule, removeSchedule } from "./scheduler.js";
import { appendLog, createEmptyState, readJson, validateState, withFileLock, writeJsonAtomic } from "./storage.js";

const VERSION = "2.2.0";
const PACKAGE_NAME = "@kkkk1723/ai-token-dashboard";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_API_URL = "https://ai-token-dashboard.tt122afadfa.workers.dev";

function parseOptions(args, {
  positionals = 0,
  booleanOptions = ["no-schedule", "no-sync", "new-device"],
  valueOptions = ["api-url", "key", "seed", "timezone", "device-name", "at"],
} = {}) {
  const options = { _: [] };
  const booleans = new Set(booleanOptions);
  const values = new Set(valueOptions);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      if (options._.length >= positionals) throw new Error("Unexpected argument: " + argument);
      options._.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleans.has(name)) {
      options[name] = true;
      continue;
    }
    if (!values.has(name)) throw new Error("Unknown option: --" + name);
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
  ai-token-dashboard pair
  ai-token-dashboard setup [pairing-string] [--device-name <name>]
  ai-token-dashboard collect
  ai-token-dashboard sync
  ai-token-dashboard status
  ai-token-dashboard doctor [--repair] [--days <1-30>]
  ai-token-dashboard uninstall

Options:
  --timezone <iana>     Account timezone (default: Asia/Shanghai)
  --device-name <name>  Friendly device label
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

function parseSetupOptions(
  args,
  { pairingRequired = false, pairingAllowed = true } = {},
) {
  const options = parseOptions(args, {
    positionals: 1,
    booleanOptions: ["no-schedule", "no-sync"],
    valueOptions: ["api-url", "timezone", "device-name", "at"],
  });
  if (pairingRequired && options._.length !== 1) {
    throw new Error("A pairing string is required.");
  }
  if (!pairingAllowed && options._.length) {
    throw new Error("A pairing string is not accepted for GitHub setup.");
  }
  return options;
}

function currentScriptPath() {
  return fileURLToPath(new URL("../bin/ai-token-dashboard.js", import.meta.url));
}

function runNpm(args, { capture = false } = {}) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: !npmExecPath && process.platform === "win32",
  });
  if (result.error) throw new Error(`Unable to run npm: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail || `npm exited with status ${result.status}.`);
  }
  return capture ? result.stdout.trim() : "";
}

async function installAndRunSetup(paths, args) {
  const options = parseSetupOptions(args);
  const pairing = options._[0] ? decodePairingBundle(options._[0]) : null;
  if (pairing && options["api-url"]) {
    throw new Error("--api-url cannot be combined with a pairing string.");
  }
  normalizeApiUrl(pairing?.apiUrl || options["api-url"] || DEFAULT_API_URL);
  if (await readJson(paths.config)) {
    throw new Error("Dashboard is already initialized on this device; setup will not overwrite it.");
  }

  console.log(`Installing ${PACKAGE_NAME}@${VERSION} from the official npm registry...`);
  runNpm([
    "install",
    "--global",
    `${PACKAGE_NAME}@${VERSION}`,
    `--registry=${NPM_REGISTRY}`,
    "--no-audit",
    "--no-fund",
  ]);
  const globalRoot = runNpm(["root", "--global"], { capture: true });
  const scriptPath = path.join(
    globalRoot,
    "@kkkk1723",
    "ai-token-dashboard",
    "bin",
    "ai-token-dashboard.js",
  );
  await fs.access(scriptPath);
  const internalCommand = pairing ? "__setup" : "__oauth-setup";
  const result = spawnSync(process.execPath, [scriptPath, internalCommand, ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error(`Unable to start the installed CLI: ${result.error.message}`);
  return Number.isInteger(result.status) ? result.status : 1;
}

async function installAutomaticSync(paths, options) {
  if (options["no-schedule"]) return;
  await installSchedule({
    nodeExecutable: process.execPath,
    scriptPath: currentScriptPath(),
    dataDirectory: paths.directory,
    at: options.at || "03:10",
  });
  console.log("Installed 60-second local collection and 10-minute dirty sync.");
}

function collectionSummary(collection) {
  return {
    imported: collection.results.reduce((sum, result) => sum + result.imported, 0),
    updated: collection.results.reduce((sum, result) => sum + (result.updated || 0), 0),
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
      `imported ${pending.imported || 0} and corrected ${pending.updated || 0} request records.`;
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
    if (collection.changed) {
      state.needsSync = true;
    }
    if (collection.changed || collection.stateChanged) {
      await writeJsonAtomic(paths.state, state);
    }
    const message =
      `Collected ${summary.imported} new and corrected ${summary.updated} request records from ` +
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

    let reconciliation = null;
    const lastReconciliation = Date.parse(
      state.diagnostics.lastReconciliation?.at || "",
    );
    if (
      !Number.isFinite(lastReconciliation) ||
      Date.now() - lastReconciliation >= 24 * 60 * 60_000
    ) {
      reconciliation = await reconcileUsage(config, state, {
        days: config.reconciliationDays || 7,
        repair: true,
      });
    }
    const collection = await collectUsage(config, state);
    const summary = collectionSummary(collection);
    if (collection.changed) state.needsSync = true;
    if (!state.needsSync && state.syncSequence > 0) {
      if (collection.stateChanged || reconciliation) {
        await writeJsonAtomic(paths.state, state);
      }
      console.log("No new local usage to sync.");
      return response;
    }
    const sequence = state.syncSequence + 1;
    const payload = {
      schemaVersion: 2,
      snapshotId: randomUUID(),
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      timezone: config.timezone,
      collectorVersion: VERSION,
      sequence,
      windowStartDate: collection.range.start,
      windowEndDate: collection.range.end,
      buckets: collection.buckets,
    };
    state.pendingSync = {
      payload,
      imported: summary.imported,
      updated: summary.updated,
      unknownModels: summary.unknownModels,
      retainFrom: collection.range.start,
      createdAt: new Date().toISOString(),
    };
    // The pending payload is the durable snapshot for all changes seen so far.
    // Any collection after this write will set needsSync again.
    state.needsSync = false;
    await writeJsonAtomic(paths.state, state);
    return uploadPending(paths, config, state);
  }, { waitMs: 60_000 });
}

async function doctor(paths, options) {
  return withFileLock(paths.lock, async () => {
    const { config, state } = await loadConfigured(paths);
    const days = Number(options.days || config.reconciliationDays || 7);
    if (!Number.isSafeInteger(days) || days < 1 || days > 30) {
      throw new Error("--days must be an integer between 1 and 30.");
    }
    const sourceDirectories = {};
    for (const [source, directory] of Object.entries(config.sources)) {
      const stat = await fs.stat(directory).catch(() => null);
      sourceDirectories[source] = {
        path: directory,
        readable: Boolean(stat?.isDirectory()),
      };
    }
    const reconciliation = await reconcileUsage(config, state, {
      days,
      repair: Boolean(options.repair),
    });
    await writeJsonAtomic(paths.state, state);
    const healthy =
      reconciliation.trustworthy &&
      state.diagnostics.status === "ok" &&
      (!reconciliation.mismatch || reconciliation.repaired);
    console.log(
      JSON.stringify(
        {
          status: healthy ? "ok" : "degraded",
          deviceId: config.deviceId,
          deviceName: config.deviceName,
          sources: sourceDirectories,
          diagnostics: state.diagnostics,
          codexQuota: state.quotaSnapshots.codex || null,
          reconciliation: {
            range: reconciliation.range,
            mismatch: reconciliation.mismatch,
            repaired: reconciliation.repaired,
            trustworthy: reconciliation.trustworthy,
          },
        },
        null,
        2,
      ),
    );
    return healthy ? 0 : 2;
  }, { waitMs: 60_000 });
}

async function initialize(paths, options) {
  const existing = await readJson(paths.config);
  const apiUrlValue = options["api-url"] || existing?.apiUrl;
  const rawKey = options.key || process.env.AI_TOKEN_DASHBOARD_KEY;
  if (!apiUrlValue) throw new Error("--api-url is required.");
  const apiUrl = normalizeApiUrl(apiUrlValue);
  if (options["new-device"] && existing?.credentialType === "device" && !rawKey) {
    throw new Error(
      "A paired device needs a new pairing code to replace its device identity.",
    );
  }
  if (!rawKey && !existing?.syncKey) throw new Error("--key or AI_TOKEN_DASHBOARD_KEY is required.");
  const timezone = options.timezone || existing?.timezone || "Asia/Shanghai";
  const config = {
    schemaVersion: 1,
    apiUrl,
    syncKey: rawKey ? protectSecret(rawKey) : existing.syncKey,
    credentialType: rawKey ? "master" : existing?.credentialType || "master",
    deviceId: options["new-device"] || !existing?.deviceId ? randomUUID() : existing.deviceId,
    deviceName: options["device-name"] || existing?.deviceName || os.hostname(),
    timezone,
    uploadDays: 45,
    reconciliationDays: existing?.reconciliationDays || 7,
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
    state.needsSync = true;
  }
  await writeJsonAtomic(paths.config, config);
  await writeJsonAtomic(paths.state, state);
  await installAutomaticSync(paths, options);
  console.log(`Initialized device ${config.deviceName} (${config.deviceId}).`);
  if (!options["no-sync"]) await sync(paths);
}

async function printPairingCommand(paths) {
  const { config } = await loadConfigured(paths);
  if (config.credentialType !== "master") {
    throw new Error("Only a device initialized with the master sync key can create pairing codes.");
  }
  const response = await createPairingCode({
    apiUrl: config.apiUrl,
    key: revealSecret(config.syncKey),
    version: VERSION,
  });
  const pairing = encodePairingBundle(config.apiUrl, response.code);
  console.log(`Pairing code expires at ${response.expiresAt}.`);
  console.log("Run this command on the new device:");
  console.log(`npx --yes ${PACKAGE_NAME}@latest setup ${pairing}`);
}

async function initializeFromPairing(paths, options) {
  if (await readJson(paths.config)) {
    throw new Error("Dashboard is already initialized on this device; setup will not overwrite it.");
  }
  const pairing = decodePairingBundle(options._[0]);
  const apiUrl = normalizeApiUrl(pairing.apiUrl);
  const deviceName = options["device-name"] || os.hostname();
  const response = await redeemPairingCode({
    apiUrl,
    code: pairing.code,
    deviceName,
    timezone: options.timezone,
    version: VERSION,
  });
  const timezone = response.timezone;
  if (typeof timezone !== "string" || !timezone || timezone.length > 80) {
    throw new Error("Worker returned an invalid account timezone.");
  }
  if (options.timezone && options.timezone !== timezone) {
    throw new Error(`Account timezone must be ${timezone}.`);
  }
  const config = {
    schemaVersion: 1,
    apiUrl,
    syncKey: protectSecret(validateDeviceToken(response.deviceToken)),
    credentialType: "device",
    deviceId: randomUUID(),
    deviceName,
    timezone,
    uploadDays: 45,
    reconciliationDays: 7,
    pricingOverrides: {},
    sources: {
      claude: defaultClaudeDirectory(),
      codex: defaultCodexDirectory(),
    },
  };
  await writeJsonAtomic(paths.config, config);
  await writeJsonAtomic(paths.state, createEmptyState());
  await installAutomaticSync(paths, options);
  console.log(`Initialized paired device ${config.deviceName} (${config.deviceId}).`);
  if (!options["no-sync"]) await sync(paths);
}

async function initializeFromGithub(paths, options) {
  if (await readJson(paths.config)) {
    throw new Error("Dashboard is already initialized on this device; setup will not overwrite it.");
  }
  const apiUrl = normalizeApiUrl(options["api-url"] || DEFAULT_API_URL);
  const deviceId = randomUUID();
  const deviceName = options["device-name"] || os.hostname();
  const response = await authorizeGithubDevice({
    apiUrl,
    deviceId,
    deviceName,
    timezone: options.timezone,
    version: VERSION,
  });
  const timezone = response.timezone;
  if (typeof timezone !== "string" || !timezone || timezone.length > 80) {
    throw new Error("Worker returned an invalid account timezone.");
  }
  if (options.timezone && options.timezone !== timezone) {
    throw new Error(`Account timezone must be ${timezone}.`);
  }
  const config = {
    schemaVersion: 1,
    apiUrl,
    syncKey: protectSecret(validateDeviceToken(response.deviceToken)),
    credentialType: "github",
    deviceId,
    deviceName,
    timezone,
    uploadDays: 45,
    reconciliationDays: 7,
    pricingOverrides: {},
    sources: {
      claude: defaultClaudeDirectory(),
      codex: defaultCodexDirectory(),
    },
  };
  await writeJsonAtomic(paths.config, config);
  await writeJsonAtomic(paths.state, createEmptyState());
  await installAutomaticSync(paths, options);
  console.log(
    `Initialized GitHub-authorized device ${config.deviceName} (${config.deviceId}).`,
  );
  if (!options["no-sync"]) await sync(paths);
}

async function status(paths) {
  const { config, state } = await loadConfigured(paths);
  console.log(JSON.stringify({
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    apiUrl: config.apiUrl,
    timezone: config.timezone,
    credentialType: config.credentialType || "master",
    lastSyncAt: state.lastSyncAt || null,
    syncSequence: state.syncSequence,
    trackedRecords: Object.keys(state.records).length,
    seedBuckets: Object.keys(state.seedBuckets).length,
    cutoffAt: state.cutoffAt,
    pendingSequence: state.pendingSync?.payload?.sequence || null,
    needsSync: state.needsSync,
    diagnostics: state.diagnostics,
    codexQuota: state.quotaSnapshots.codex || null,
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
    if (command === "setup") return installAndRunSetup(paths, rest);
    if (command === "init") await initialize(paths, parseOptions(rest));
    else if (command === "__setup") {
      await initializeFromPairing(
        paths,
        parseSetupOptions(rest, { pairingRequired: true }),
      );
    } else if (command === "__oauth-setup") {
      await initializeFromGithub(
        paths,
        parseSetupOptions(rest, { pairingAllowed: false }),
      );
    } else if (command === "pair") {
      parseOptions(rest, {
        booleanOptions: [],
        valueOptions: [],
      });
      await printPairingCommand(paths);
    } else if (command === "collect") await collectLocal(paths);
    else if (command === "sync") await sync(paths);
    else if (command === "status") await status(paths);
    else if (command === "doctor") {
      return doctor(
        paths,
        parseOptions(rest, {
          booleanOptions: ["repair"],
          valueOptions: ["days"],
        }),
      );
    } else if (command === "uninstall") {
      await removeSchedule();
      console.log("Removed the automatic collection and sync schedules. Local usage data was retained.");
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
