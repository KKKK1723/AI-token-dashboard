import { collectClaudeUsage } from "./collectors/claude.js";
import { collectCodexUsage } from "./collectors/codex.js";
import { createPricingCatalog } from "./pricing.js";
import { aggregateDailyBuckets } from "./records.js";
import { rollingDateRange } from "./time.js";

export async function collectUsage(config, state) {
  const pricingCatalog = createPricingCatalog(config.pricingOverrides || {});
  const common = { state, timezone: config.timezone, pricingCatalog };
  const results = [
    await collectClaudeUsage({ ...common, claudeDirectory: config.sources.claude }),
    await collectCodexUsage({ ...common, codexDirectory: config.sources.codex }),
  ];
  const errors = results.flatMap((result) => result.errors);
  const collectedAt = new Date().toISOString();
  for (const result of results) {
    const degraded =
      result.errors.length > 0 ||
      result.malformedRelevantLines > 0 ||
      result.unsupportedEvents > 0 ||
      (result.counterAnomalies || 0) > 0 ||
      (result.deferred || 0) > 0;
    const previous = state.diagnostics.sources[result.source] || {};
    state.diagnostics.sources[result.source] =
      result.changedFiles > 0 || !previous.lastCollectedAt
        ? {
            status: degraded ? "degraded" : "ok",
            lastCollectedAt: collectedAt,
            filesScanned: result.filesScanned,
            changedFiles: result.changedFiles,
            relevantEvents: result.relevantEvents || 0,
            imported: result.imported,
            updated: result.updated || 0,
            skipped: result.skipped,
            deferred: result.deferred || 0,
            malformedRelevantLines: result.malformedRelevantLines || 0,
            unsupportedEvents: result.unsupportedEvents || 0,
            counterResets: result.counterResets || 0,
            counterAnomalies: result.counterAnomalies || 0,
          }
        : { ...previous, lastCheckedAt: collectedAt };
  }
  const issues = results.flatMap((result) => [
    ...(result.issues || []),
    ...result.errors,
  ]);
  if (issues.length) {
    state.diagnostics.issues = issues.slice(0, 20);
  } else if (results.some((result) => result.changedFiles > 0)) {
    state.diagnostics.issues = [];
  }
  state.diagnostics.lastCollectionAt = collectedAt;
  state.diagnostics.status = Object.values(state.diagnostics.sources).some(
    (source) => source.status === "degraded",
  )
    ? "degraded"
    : "ok";
  state.diagnostics.lastCollectionStatus = errors.length ? "failed" : state.diagnostics.status;
  if (errors.length) {
    throw new Error(`Usage collection failed:\n${errors.slice(0, 10).join("\n")}`);
  }
  const range = rollingDateRange(new Date(), config.timezone, config.uploadDays || 45);
  return {
    results,
    changed: results.some((result) => result.imported > 0 || (result.updated || 0) > 0),
    stateChanged: results.some(
      (result) => result.changedFiles > 0 || result.quotaUpdated,
    ),
    buckets: aggregateDailyBuckets(state, range),
    range,
    unknownModels: [...new Set(results.flatMap((result) => [...result.unknownModels]))],
  };
}
