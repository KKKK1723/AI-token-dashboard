import fs from "node:fs/promises";
import path from "node:path";

import { addUsageRecord } from "../records.js";
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

// This mirrors CC Switch 3.18.0 session_usage.rs: incremental line cursors,
// message.id deduplication, stop_reason preference, then largest output count.
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
    skipped: 0,
    unknownModels: new Set(),
    errors: [],
  };
  for (const file of await collectClaudeFiles(claudeDirectory)) {
    result.filesScanned += 1;
    try {
      const stat = await fs.stat(file);
      const cursor = state.fileCursors[file] || { lineOffset: 0, mtimeMs: 0, size: 0 };
      if (stat.mtimeMs <= cursor.mtimeMs && stat.size === cursor.size) continue;
      const lines = parseLines(await fs.readFile(file, "utf8"));
      const start = lines.length < cursor.lineOffset ? 0 : cursor.lineOffset;
      const messages = new Map();
      for (let index = start; index < lines.length; index += 1) {
        let value;
        try {
          value = JSON.parse(lines[index]);
        } catch {
          continue;
        }
        if (value?.type !== "assistant") continue;
        const message = value.message;
        const usage = message?.usage;
        if (!message?.id || !usage) continue;
        const parsed = {
          messageId: String(message.id),
          model: String(message.model || "unknown"),
          inputTokens: Number(usage.input_tokens || 0),
          outputTokens: Number(usage.output_tokens || 0),
          cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
          cacheCreationTokens: Number(usage.cache_creation_input_tokens || 0),
          stopReason: message.stop_reason ?? null,
          timestamp: value.timestamp || null,
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
        const occurredAt = new Date(message.timestamp || Date.now()).toISOString();
        const insertion = addUsageRecord(
          state,
          `session:${message.messageId}`,
          {
            date: dateInTimezone(occurredAt, timezone),
            source: "claude",
            model: message.model,
            requests: 1,
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
            cacheReadTokens: message.cacheReadTokens,
            cacheCreationTokens: message.cacheCreationTokens,
            dataThrough: occurredAt,
          },
          pricingCatalog,
        );
        if (insertion.inserted) result.imported += 1;
        else result.skipped += 1;
        if (insertion.unknownModel) result.unknownModels.add(insertion.unknownModel);
      }
      state.fileCursors[file] = {
        lineOffset: lines.length,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        source: "claude",
      };
      result.changedFiles += 1;
    } catch (error) {
      result.errors.push(`${file}: ${error.message}`);
    }
  }
  return result;
}

export const claudeInternals = { parseLines, shouldReplaceClaudeUsage };
