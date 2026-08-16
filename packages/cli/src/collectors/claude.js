import fs from "node:fs/promises";
import path from "node:path";

import { upsertUsageRecord } from "../records.js";
import { dateInTimezone } from "../time.js";

async function directoryEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function appendJsonlChildren(directory, files) {
  for (const entry of await directoryEntries(directory)) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path.join(directory, entry.name));
    }
  }
}

export async function collectClaudeFiles(claudeDirectory) {
  const projects = path.join(claudeDirectory, "projects");
  const files = [];
  for (const project of await directoryEntries(projects)) {
    if (!project.isDirectory()) continue;
    const projectDirectory = path.join(projects, project.name);
    for (const entry of await directoryEntries(projectDirectory)) {
      const child = path.join(projectDirectory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(child);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const subagents = path.join(child, "subagents");
      await appendJsonlChildren(subagents, files);
      const workflows = path.join(subagents, "workflows");
      for (const workflow of await directoryEntries(workflows)) {
        if (workflow.isDirectory()) {
          await appendJsonlChildren(path.join(workflows, workflow.name), files);
        }
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function parseLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function shouldReplaceClaudeUsage(existing, candidate) {
  if (!existing) return true;
  const candidateStopped = candidate.stopReason != null;
  const existingStopped = existing.stopReason != null;
  if (candidateStopped && !existingStopped) return true;
  if (candidateStopped === existingStopped) {
    return candidate.outputTokens > existing.outputTokens;
  }
  return false;
}

function timestampAfterCutoff(timestamp, cutoffAt) {
  if (!cutoffAt) return true;
  const value = Date.parse(timestamp || "");
  return Number.isFinite(value) && value > Date.parse(cutoffAt);
}

function usageCounter(value) {
  const result = Number(value ?? 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function noteIssue(result, issue) {
  if (result.issues.length < 10) result.issues.push(issue);
}

// This mirrors CC Switch 3.18.0 session_usage.rs while allowing a later,
// completed snapshot of the same message to correct an earlier partial one.
export async function collectClaudeUsage({
  state,
  claudeDirectory,
  timezone,
  pricingCatalog,
}) {
  const result = {
    source: "claude",
    filesScanned: 0,
    changedFiles: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    relevantEvents: 0,
    malformedRelevantLines: 0,
    unsupportedEvents: 0,
    unknownModels: new Set(),
    issues: [],
    errors: [],
  };
  for (const file of await collectClaudeFiles(claudeDirectory)) {
    result.filesScanned += 1;
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
      const text = await fs.readFile(file, "utf8");
      const lines = parseLines(text);
      const start = lines.length < cursor.lineOffset ? 0 : cursor.lineOffset;
      const messages = new Map();
      let processedLineOffset = lines.length;
      let complete = true;
      for (let index = start; index < lines.length; index += 1) {
        let value;
        try {
          value = JSON.parse(lines[index]);
        } catch {
          const incompleteTail = index === lines.length - 1 && !/\r?\n$/.test(text);
          if (incompleteTail) {
            processedLineOffset = index;
            complete = false;
            break;
          }
          if (lines[index].includes('"assistant"') || lines[index].includes('"usage"')) {
            result.malformedRelevantLines += 1;
            noteIssue(result, `${file}:${index + 1}: malformed Claude usage JSON`);
          }
          continue;
        }
        if (value?.type !== "assistant") continue;
        result.relevantEvents += 1;
        const message = value.message;
        const usage = message?.usage;
        const timestampMs = Date.parse(value.timestamp || "");
        if (!message?.id || !usage || !Number.isFinite(timestampMs)) {
          result.unsupportedEvents += 1;
          noteIssue(result, `${file}:${index + 1}: incomplete Claude assistant usage event`);
          continue;
        }
        const counters = {
          inputTokens: usageCounter(usage.input_tokens),
          outputTokens: usageCounter(usage.output_tokens),
          cacheReadTokens: usageCounter(usage.cache_read_input_tokens),
          cacheCreationTokens: usageCounter(usage.cache_creation_input_tokens),
        };
        if (Object.values(counters).some((counter) => counter == null)) {
          result.unsupportedEvents += 1;
          noteIssue(result, `${file}:${index + 1}: invalid Claude token counters`);
          continue;
        }
        const parsed = {
          messageId: String(message.id),
          model: String(message.model || "unknown"),
          ...counters,
          stopReason: message.stop_reason ?? null,
          timestamp: new Date(timestampMs).toISOString(),
        };
        if (shouldReplaceClaudeUsage(messages.get(parsed.messageId), parsed)) {
          messages.set(parsed.messageId, parsed);
        }
      }

      for (const message of messages.values()) {
        const hasTokens =
          message.inputTokens > 0 ||
          message.outputTokens > 0 ||
          message.cacheReadTokens > 0 ||
          message.cacheCreationTokens > 0;
        if (!hasTokens || !timestampAfterCutoff(message.timestamp, state.cutoffAt)) continue;
        const insertion = upsertUsageRecord(
          state,
          `session:${message.messageId}`,
          {
            date: dateInTimezone(message.timestamp, timezone),
            source: "claude",
            model: message.model,
            requests: 1,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
            cacheReadTokens: message.cacheReadTokens,
            cacheCreationTokens: message.cacheCreationTokens,
            dataThrough: message.timestamp,
            stopReason: message.stopReason,
          },
          pricingCatalog,
          { shouldReplace: shouldReplaceClaudeUsage },
        );
        if (insertion.inserted) result.imported += 1;
        else if (insertion.updated) result.updated += 1;
        else result.skipped += 1;
        if (insertion.unknownModel) result.unknownModels.add(insertion.unknownModel);
      }
      state.fileCursors[file] = {
        lineOffset: processedLineOffset,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        source: "claude",
        complete,
      };
      result.changedFiles += 1;
    } catch (error) {
      result.errors.push(`${file}: ${error.message}`);
    }
  }
  return result;
}

export const claudeInternals = { parseLines, shouldReplaceClaudeUsage, usageCounter };
