import fs from "node:fs/promises";

import { collectUsage } from "./collector.js";
import { aggregateDailyBuckets } from "./records.js";
import { createEmptyState } from "./storage.js";
import { rollingDateRange } from "./time.js";

const COLLECTOR_SOURCES = ["claude", "codex"];

function sourceRecordsInRange(records, range, sources) {
  const included = new Set(sources);
  return Object.fromEntries(
    Object.entries(records).filter(
      ([, record]) =>
        included.has(record.source) &&
        record.date >= range.start &&
        record.date <= range.end,
    ),
  );
}

function usageBuckets(state, range, sources = COLLECTOR_SOURCES) {
  return aggregateDailyBuckets(
    {
      records: sourceRecordsInRange(state.records, range, sources),
      seedBuckets: {},
    },
    range,
  );
}

function recordsInRange(records, range) {
  return Object.fromEntries(
    Object.entries(records).filter(
      ([, record]) => record.date >= range.start && record.date <= range.end,
    ),
  );
}

async function sourceAvailability(config) {
  const entries = await Promise.all(
    COLLECTOR_SOURCES.map(async (source) => {
      const directory = config.sources?.[source];
      const stat = directory
        ? await fs.stat(directory).catch(() => null)
        : null;
      return [source, Boolean(stat?.isDirectory())];
    }),
  );
  return Object.fromEntries(entries);
}

function replaceRecentCollectorState(state, scratch, range, sources) {
  const included = new Set(sources);
  for (const [id, record] of Object.entries(state.records)) {
    if (
      included.has(record.source) &&
      record.date >= range.start &&
      record.date <= range.end
    ) {
      delete state.records[id];
    }
  }
  Object.assign(
    state.records,
    sourceRecordsInRange(scratch.records, range, sources),
  );
  for (const [file, cursor] of Object.entries(state.fileCursors)) {
    if (included.has(cursor.source)) delete state.fileCursors[file];
  }
  for (const [file, cursor] of Object.entries(scratch.fileCursors)) {
    if (included.has(cursor.source)) state.fileCursors[file] = cursor;
  }
  if (included.has("codex") && scratch.quotaSnapshots.codex) {
    state.quotaSnapshots.codex = scratch.quotaSnapshots.codex;
  }
}

export async function reconcileUsage(
  config,
  state,
  { days = 7, repair = false, now = new Date() } = {},
) {
  const range = rollingDateRange(now, config.timezone, days);
  const scratch = createEmptyState();
  scratch.cutoffAt = state.cutoffAt;
  const collection = await collectUsage(config, scratch);
  const availability = await sourceAvailability(config);
  const availableSources = COLLECTOR_SOURCES.filter(
    (source) => availability[source],
  );
  const unavailableTrackedSources = COLLECTOR_SOURCES.filter(
    (source) =>
      !availability[source] &&
      Object.values(state.records).some(
        (record) =>
          record.source === source &&
          record.date >= range.start &&
          record.date <= range.end,
      ),
  );
  const expected = usageBuckets(scratch, range, availableSources);
  const actual = usageBuckets(state, range, availableSources);
  const mismatch = JSON.stringify(actual) !== JSON.stringify(expected);
  const completedAt = new Date().toISOString();
  const trustworthy =
    availableSources.length > 0 &&
    unavailableTrackedSources.length === 0 &&
    availableSources.every(
      (source) => scratch.diagnostics.sources[source]?.status === "ok",
    );
  const repaired = mismatch && repair && trustworthy;
  if (repaired) {
    replaceRecentCollectorState(state, scratch, range, availableSources);
    state.needsSync = true;
    state.diagnostics.sources = scratch.diagnostics.sources;
    state.diagnostics.status = scratch.diagnostics.status;
    state.diagnostics.issues = scratch.diagnostics.issues;
  }
  if (scratch.quotaSnapshots.codex) {
    state.quotaSnapshots.codex = scratch.quotaSnapshots.codex;
  }
  state.diagnostics.lastReconciliation = {
    at: completedAt,
    status:
      !trustworthy
        ? "degraded"
        : mismatch && !repair
          ? "mismatch"
          : "ok",
    repaired,
    trustworthy,
    range,
    sourceAvailability: availability,
    expectedBuckets: expected.length,
    actualBuckets: actual.length,
  };
  if (!trustworthy || (mismatch && !repaired)) {
    state.diagnostics.status = "degraded";
    const unavailableIssues = unavailableTrackedSources.map(
      (source) =>
        `Cannot reconcile ${source}: its source directory is unavailable while recent records still exist.`,
    );
    state.diagnostics.issues = [
      ...unavailableIssues,
      ...(mismatch && trustworthy
        ? [
            `Recent full scan differs from incremental state for ${range.start} through ${range.end}.`,
          ]
        : []),
      ...(!trustworthy && unavailableIssues.length === 0
        ? ["Full-scan diagnostics are degraded, so automatic repair was not applied."]
        : []),
      ...state.diagnostics.issues,
    ].slice(0, 20);
  }
  return {
    mismatch,
    repaired,
    trustworthy,
    range,
    sourceAvailability: availability,
    expected,
    actual,
    collection,
  };
}

export const reconciliationInternals = {
  recordsInRange,
  sourceAvailability,
  sourceRecordsInRange,
  usageBuckets,
};
