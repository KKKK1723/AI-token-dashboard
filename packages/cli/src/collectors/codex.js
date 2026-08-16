import fs from "node:fs/promises";
import path from "node:path";

import { upsertUsageRecord } from "../records.js";
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    input: value.input_tokens ?? null,
    cachedInput: value.cached_input_tokens ?? value.cache_read_input_tokens ?? null,
    cacheWrite: value.cache_write_input_tokens ?? value.cache_creation_input_tokens ?? null,
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

function safeCounter(value) {
  const result = Number(value ?? 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function cumulativeTokens(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {
    input: safeCounter(value.input_tokens),
    cachedInput: safeCounter(value.cached_input_tokens ?? value.cache_read_input_tokens),
    cacheWrite: safeCounter(
      value.cache_write_input_tokens ?? value.cache_creation_input_tokens,
    ),
    output: safeCounter(value.output_tokens),
  };
  if (Object.values(result).some((counter) => counter == null)) return null;
  if (result.cachedInput > result.input) return null;
  return result;
}

function countersDecreased(previous, current) {
  return Boolean(
    previous &&
      (current.input < previous.input ||
        current.cachedInput < previous.cachedInput ||
        current.cacheWrite < previous.cacheWrite ||
        current.output < previous.output),
  );
}

function computeDelta(previous, current) {
  if (!previous || countersDecreased(previous, current)) return { ...current };
  return {
    input: current.input - previous.input,
    cachedInput: current.cachedInput - previous.cachedInput,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
    output: current.output - previous.output,
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

function cloneRateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 32 * 1024) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
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
  let latestRateLimit = null;
  let processedLineOffset = lines.length;
  let complete = true;
  let relevantEvents = 0;
  let malformedRelevantLines = 0;
  let unsupportedEvents = 0;
  let counterResets = 0;
  let counterAnomalies = 0;
  const issues = [];
  const tokenEvents = [];
  const note = (line, message) => {
    if (issues.length < 10) issues.push({ line, message });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const looksRelevant =
      line.includes('"event_msg"') ||
      line.includes('"turn_context"') ||
      line.includes('"session_meta"') ||
      line.includes('"token_count"');
    if (!looksRelevant) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      const incompleteTail = index === lines.length - 1 && !/\r?\n$/.test(text);
      if (incompleteTail) {
        processedLineOffset = index;
        complete = false;
        break;
      }
      malformedRelevantLines += 1;
      note(index + 1, "malformed Codex event JSON");
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
    relevantEvents += 1;
    const timestampMs = Date.parse(value.timestamp || "");
    if (value.payload.rate_limits != null) {
      const rateLimits = cloneRateLimits(value.payload.rate_limits);
      if (rateLimits && Number.isFinite(timestampMs)) {
        const observedAt = new Date(timestampMs).toISOString();
        if (!latestRateLimit || observedAt >= latestRateLimit.observedAt) {
          latestRateLimit = { observedAt, rateLimits };
        }
      } else {
        unsupportedEvents += 1;
        note(index + 1, "invalid Codex rate-limit snapshot");
      }
    }
    const info = value.payload.info;
    if (!info) {
      if (value.payload.rate_limits == null) {
        unsupportedEvents += 1;
        note(index + 1, "Codex token event has neither usage nor rate limits");
      }
      continue;
    }
    const signature = tokenSignature(info);
    const total = info.total_token_usage;
    const last = info.last_token_usage;
    const cumulative = cumulativeTokens(total || last);
    if (!signature || !cumulative || !Number.isFinite(timestampMs)) {
      unsupportedEvents += 1;
      note(index + 1, "unsupported Codex token usage schema");
      continue;
    }
    const inlineModel = info.model || info.model_name || value.payload.model;
    if (inlineModel) currentModel = normalizeCodexModel(inlineModel);
    let delta;
    let reset = false;
    if (total) {
      reset = countersDecreased(previousTotal, cumulative);
      delta = computeDelta(previousTotal, cumulative);
      previousTotal = cumulative;
      if (reset) counterResets += 1;
    } else {
      delta = cumulative;
    }
    const cachedInput = Math.min(delta.cachedInput, delta.input);
    const cacheWrite = Math.min(delta.cacheWrite, delta.input - cachedInput);
    if (cachedInput !== delta.cachedInput || cacheWrite !== delta.cacheWrite) {
      counterAnomalies += 1;
      note(index + 1, "Codex cache counters exceed total input tokens");
    }
    delta.cachedInput = cachedInput;
    delta.cacheWrite = cacheWrite;
    const nonzero = delta.input !== 0 || delta.cachedInput !== 0 || delta.output !== 0;
    if (nonzero) eventIndex += 1;
    tokenEvents.push({
      lineOffset: index + 1,
      signature,
      delta,
      eventIndex: nonzero ? eventIndex : null,
      model: currentModel,
      timestamp: new Date(timestampMs).toISOString(),
      reset,
    });
  }
  return {
    rootThreadId,
    rootMetaSeen,
    rootTimestamp,
    parent,
    tokenEvents,
    latestRateLimit,
    lineOffset: processedLineOffset,
    complete,
    hasBillableTokens: eventIndex > 0,
    relevantEvents,
    malformedRelevantLines,
    unsupportedEvents,
    counterResets,
    counterAnomalies,
    issues,
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

function updateQuotaSnapshot(state, result, file, candidate) {
  if (!candidate) return;
  const next = { ...candidate, sourceFile: file };
  const existing = state.quotaSnapshots.codex;
  if (existing?.observedAt && existing.observedAt > next.observedAt) return;
  if (JSON.stringify(existing) === JSON.stringify(next)) return;
  state.quotaSnapshots.codex = next;
  result.quotaUpdated = true;
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
    updated: 0,
    skipped: 0,
    deferred: 0,
    relevantEvents: 0,
    malformedRelevantLines: 0,
    unsupportedEvents: 0,
    counterResets: 0,
    counterAnomalies: 0,
    quotaUpdated: false,
    unknownModels: new Set(),
    issues: [],
    errors: [],
  };
  const noteIssue = (issue) => {
    if (result.issues.length < 10) result.issues.push(issue);
  };
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      const cursor = state.fileCursors[file] || {
        lineOffset: 0,
        mtimeMs: 0,
        size: 0,
        complete: true,
      };
      if (
        cursor.complete !== false &&
        stat.mtimeMs <= cursor.mtimeMs &&
        stat.size === cursor.size
      ) {
        continue;
      }
      const rootThreadId = threadIdFromFilename(file);
      const parsed = parseCodexText(await fs.readFile(file, "utf8"), rootThreadId);
      result.relevantEvents += parsed.relevantEvents;
      result.malformedRelevantLines += parsed.malformedRelevantLines;
      result.unsupportedEvents += parsed.unsupportedEvents;
      result.counterResets += parsed.counterResets;
      result.counterAnomalies += parsed.counterAnomalies;
      for (const issue of parsed.issues) {
        noteIssue(`${file}:${issue.line}: ${issue.message}`);
      }
      updateQuotaSnapshot(state, result, file, parsed.latestRateLimit);
      if (!parsed.hasBillableTokens) {
        state.fileCursors[file] = {
          lineOffset: parsed.lineOffset,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          source: "codex",
          complete: parsed.complete,
        };
        result.changedFiles += 1;
        continue;
      }
      if (!rootThreadId || !parsed.rootMetaSeen || parsed.parent.kind === "deferred") {
        result.deferred += 1;
        noteIssue(
          `${file}: ${parsed.parent.reason || "Codex rollout identity is incomplete"}`,
        );
        continue;
      }
      let replayPrefix = 0;
      if (parsed.parent.kind === "parent") {
        const candidates = rolloutIndex.get(parsed.parent.parentId);
        if (!candidates?.length || !parsed.rootTimestamp) {
          result.deferred += 1;
          noteIssue(`${file}: parent rollout is not available yet`);
          continue;
        }
        const snapshots = [];
        for (const candidate of candidates) {
          snapshots.push(await parentSignaturesBefore(candidate, parsed.rootTimestamp));
        }
        if (snapshots.some((value) => JSON.stringify(value) !== JSON.stringify(snapshots[0]))) {
          result.deferred += 1;
          noteIssue(`${file}: parent rollout copies disagree`);
          continue;
        }
        replayPrefix = matchingReplayPrefix(parsed.tokenEvents, snapshots[0]);
      }

      for (let offset = 0; offset < parsed.tokenEvents.length; offset += 1) {
        const event = parsed.tokenEvents[offset];
        if (event.eventIndex == null || offset < replayPrefix || event.lineOffset <= cursor.lineOffset) continue;
        if (!timestampAfterCutoff(event.timestamp, state.cutoffAt)) continue;
        const freshInput =
          event.delta.input - event.delta.cachedInput - event.delta.cacheWrite;
        const insertion = upsertUsageRecord(
          state,
          `${THREAD_REQUEST_PREFIX}:${rootThreadId}:${event.eventIndex}`,
          {
            date: dateInTimezone(event.timestamp, timezone),
            source: "codex",
            model: event.model,
            requests: 1,
            inputTokens: freshInput,
            outputTokens: event.delta.output,
            cacheReadTokens: event.delta.cachedInput,
            cacheCreationTokens: event.delta.cacheWrite,
            dataThrough: event.timestamp,
            counterReset: event.reset,
          },
          pricingCatalog,
        );
        if (insertion.inserted) result.imported += 1;
        else if (insertion.updated) result.updated += 1;
        else result.skipped += 1;
        if (insertion.unknownModel) result.unknownModels.add(insertion.unknownModel);
      }
      state.fileCursors[file] = {
        lineOffset: parsed.lineOffset,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        source: "codex",
        complete: parsed.complete,
      };
      result.changedFiles += 1;
    } catch (error) {
      result.errors.push(`${file}: ${error.message}`);
    }
  }
  return result;
}

export const codexInternals = {
  cloneRateLimits,
  computeDelta,
  countersDecreased,
  matchingReplayPrefix,
  parseCodexText,
  threadIdFromFilename,
  tokenSignature,
};
