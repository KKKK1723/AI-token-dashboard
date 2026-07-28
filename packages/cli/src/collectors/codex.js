import fs from "node:fs/promises";
import path from "node:path";

import { addUsageRecord } from "../records.js";
import { dateInTimezone } from "../time.js";

const THREAD_REQUEST_PREFIX = "codex_session:thread-v1";
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

async function walkJsonl(directory, output, depth, maximumDepth) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory() && depth < maximumDepth) {
      await walkJsonl(child, output, depth + 1, maximumDepth);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(child);
    }
  }
}

export async function collectCodexFiles(codexDirectory) {
  const files = [];
  await walkJsonl(path.join(codexDirectory, "sessions"), files, 0, 3);
  await walkJsonl(path.join(codexDirectory, "archived_sessions"), files, 0, 0);
  return files.sort((left, right) => left.localeCompare(right));
}

function threadIdFromFilename(file) {
  const stem = path.basename(file, path.extname(file));
  return stem.match(UUID_AT_END)?.[1]?.toLowerCase() || null;
}

export function normalizeCodexModel(raw) {
  let model = String(raw || "unknown").toLowerCase().split("/").at(-1);
  model = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  model = model.replace(/-\d{8}$/, "");
  return model;
}

function signatureCounters(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input: value.input_tokens ?? null,
    cachedInput: value.cached_input_tokens ?? value.cache_read_input_tokens ?? null,
    output: value.output_tokens ?? null,
    reasoningOutput: value.reasoning_output_tokens ?? null,
    total: value.total_tokens ?? null,
  };
}

function tokenSignature(info) {
  const signature = {
    total: signatureCounters(info?.total_token_usage),
    last: signatureCounters(info?.last_token_usage),
  };
  return signature.total || signature.last ? JSON.stringify(signature) : null;
}

function cumulativeTokens(value) {
  if (!value || typeof value !== "object") return null;
  return {
    input: Number(value.input_tokens || 0),
    cachedInput: Number(value.cached_input_tokens ?? value.cache_read_input_tokens ?? 0),
    output: Number(value.output_tokens || 0),
  };
}

function computeDelta(previous, current) {
  if (!previous) return { ...current };
  return {
    input: Math.max(0, current.input - previous.input),
    cachedInput: Math.max(0, current.cachedInput - previous.cachedInput),
    output: Math.max(0, current.output - previous.output),
  };
}

function explicitParent(payload) {
  const forked = payload?.forked_from_id || null;
  const spawned = payload?.source?.subagent?.thread_spawn?.parent_thread_id || null;
  if (!forked && !spawned) return { kind: "none" };
  if (forked && spawned && String(forked).toLowerCase() !== String(spawned).toLowerCase()) {
    return { kind: "deferred", reason: "Conflicting Codex parent thread identifiers." };
  }
  const parentId = String(forked || spawned).toLowerCase();
  if (!UUID_AT_END.test(parentId)) {
    return { kind: "deferred", reason: "Codex parent thread identifier is not a UUID." };
  }
  return { kind: "parent", parentId };
}

function parseCodexText(text, rootThreadId) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let rootMetaSeen = false;
  let rootTimestamp = null;
  let parent = { kind: "none" };
  let currentModel = "unknown";
  let previousTotal = null;
  let eventIndex = 0;
  const tokenEvents = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes('"event_msg"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
    if (line.includes('"event_msg"') && !line.includes('"token_count"')) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "session_meta" && !rootMetaSeen) {
      rootMetaSeen = true;
      rootTimestamp = value.timestamp || null;
      parent = explicitParent(value.payload || {});
      const metaId = value.payload?.id || value.payload?.thread_id || value.payload?.threadId;
      if (rootThreadId && metaId && String(metaId).toLowerCase() !== rootThreadId) {
        parent = { kind: "deferred", reason: "Codex filename and session metadata IDs differ." };
      }
      if (parent.kind === "parent" && parent.parentId === rootThreadId) {
        parent = { kind: "deferred", reason: "Codex thread points to itself as parent." };
      }
      continue;
    }
    if (value.type === "turn_context") {
      const model = value.payload?.model || value.payload?.info?.model;
      if (model) currentModel = normalizeCodexModel(model);
      continue;
    }
    if (value.type !== "event_msg" || value.payload?.type !== "token_count") continue;
    const info = value.payload.info;
    if (!info) continue;
    const signature = tokenSignature(info);
    if (!signature) continue;
    const inlineModel = info.model || info.model_name || value.payload.model;
    if (inlineModel) currentModel = normalizeCodexModel(inlineModel);
    const total = info.total_token_usage;
    const last = info.last_token_usage;
    const cumulative = cumulativeTokens(total || last);
    if (!cumulative) continue;
    let delta;
    if (total) {
      delta = computeDelta(previousTotal, cumulative);
      previousTotal = cumulative;
    } else {
      delta = cumulative;
    }
    delta.cachedInput = Math.min(delta.cachedInput, delta.input);
    const nonzero = delta.input !== 0 || delta.cachedInput !== 0 || delta.output !== 0;
    if (nonzero) eventIndex += 1;
    tokenEvents.push({
      lineOffset: index + 1,
      signature,
      delta,
      eventIndex: nonzero ? eventIndex : null,
      model: currentModel,
      timestamp: value.timestamp || null,
    });
  }
  return {
    rootThreadId,
    rootMetaSeen,
    rootTimestamp,
    parent,
    tokenEvents,
    lineOffset: lines.length,
    hasBillableTokens: eventIndex > 0,
  };
}

async function parentSignaturesBefore(file, cutoff) {
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) throw new Error("Child Codex rollout has no valid timestamp.");
  const signatures = [];
  let maximumTimestamp = null;
  const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = Date.parse(value.timestamp || "");
    if (Number.isFinite(timestamp)) {
      maximumTimestamp = maximumTimestamp == null ? timestamp : Math.max(maximumTimestamp, timestamp);
    }
    if (value.type !== "event_msg" || value.payload?.type !== "token_count" || !value.payload.info) continue;
    const signature = tokenSignature(value.payload.info);
    if (!signature) continue;
    if (!Number.isFinite(timestamp)) throw new Error("Parent Codex token event has no timestamp.");
    if (timestamp <= cutoffMs) signatures.push(signature);
  }
  if (maximumTimestamp == null || maximumTimestamp < cutoffMs) {
    throw new Error("Parent Codex rollout has not reached the child fork timestamp.");
  }
  return signatures;
}

function matchingReplayPrefix(childEvents, parentSignatures) {
  let parentOffset = 0;
  let matched = 0;
  for (const event of childEvents) {
    const relative = parentSignatures.slice(parentOffset).indexOf(event.signature);
    if (relative < 0) break;
    parentOffset += relative + 1;
    matched += 1;
  }
  return matched;
}

function timestampAfterCutoff(timestamp, cutoffAt) {
  if (!cutoffAt) return true;
  const value = Date.parse(timestamp || "");
  return Number.isFinite(value) && value > Date.parse(cutoffAt);
}

// This is a JavaScript port of CC Switch 3.18.0 session_usage_codex.rs.
export async function collectCodexUsage({
  state,
  codexDirectory,
  timezone,
  pricingCatalog,
}) {
  const files = await collectCodexFiles(codexDirectory);
  const rolloutIndex = new Map();
  for (const file of files) {
    const threadId = threadIdFromFilename(file);
    if (!threadId) continue;
    if (!rolloutIndex.has(threadId)) rolloutIndex.set(threadId, []);
    rolloutIndex.get(threadId).push(file);
  }
  const result = {
    source: "codex",
    filesScanned: files.length,
    changedFiles: 0,
    imported: 0,
    skipped: 0,
    deferred: 0,
    unknownModels: new Set(),
    errors: [],
  };
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      const cursor = state.fileCursors[file] || { lineOffset: 0, mtimeMs: 0, size: 0 };
      if (stat.mtimeMs <= cursor.mtimeMs && stat.size === cursor.size) continue;
      const rootThreadId = threadIdFromFilename(file);
      const parsed = parseCodexText(await fs.readFile(file, "utf8"), rootThreadId);
      if (!parsed.hasBillableTokens) {
        state.fileCursors[file] = { lineOffset: parsed.lineOffset, mtimeMs: stat.mtimeMs, size: stat.size, source: "codex" };
        result.changedFiles += 1;
        continue;
      }
      if (!rootThreadId || !parsed.rootMetaSeen || parsed.parent.kind === "deferred") {
        result.deferred += 1;
        continue;
      }
      let replayPrefix = 0;
      if (parsed.parent.kind === "parent") {
        const candidates = rolloutIndex.get(parsed.parent.parentId);
        if (!candidates?.length || !parsed.rootTimestamp) {
          result.deferred += 1;
          continue;
        }
        const snapshots = [];
        for (const candidate of candidates) {
          snapshots.push(await parentSignaturesBefore(candidate, parsed.rootTimestamp));
        }
        if (snapshots.some((value) => JSON.stringify(value) !== JSON.stringify(snapshots[0]))) {
          result.deferred += 1;
          continue;
        }
        replayPrefix = matchingReplayPrefix(parsed.tokenEvents, snapshots[0]);
      }

      for (let offset = 0; offset < parsed.tokenEvents.length; offset += 1) {
        const event = parsed.tokenEvents[offset];
        if (event.eventIndex == null || offset < replayPrefix || event.lineOffset <= cursor.lineOffset) continue;
        if (!timestampAfterCutoff(event.timestamp, state.cutoffAt)) continue;
        const occurredAt = new Date(event.timestamp || Date.now()).toISOString();
        const freshInput = Math.max(0, event.delta.input - event.delta.cachedInput);
        const insertion = addUsageRecord(
          state,
          `${THREAD_REQUEST_PREFIX}:${rootThreadId}:${event.eventIndex}`,
          {
            date: dateInTimezone(occurredAt, timezone),
            source: "codex",
            model: event.model,
            requests: 1,
            inputTokens: freshInput,
            outputTokens: event.delta.output,
            cacheReadTokens: event.delta.cachedInput,
            cacheCreationTokens: 0,
            dataThrough: occurredAt,
          },
          pricingCatalog,
        );
        if (insertion.inserted) result.imported += 1;
        else result.skipped += 1;
        if (insertion.unknownModel) result.unknownModels.add(insertion.unknownModel);
      }
      state.fileCursors[file] = {
        lineOffset: parsed.lineOffset,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        source: "codex",
      };
      result.changedFiles += 1;
    } catch (error) {
      result.errors.push(`${file}: ${error.message}`);
    }
  }
  return result;
}

export const codexInternals = {
  computeDelta,
  matchingReplayPrefix,
  parseCodexText,
  threadIdFromFilename,
  tokenSignature,
};
