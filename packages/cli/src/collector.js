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
  if (errors.length) {
    throw new Error(`Usage collection failed:\n${errors.slice(0, 10).join("\n")}`);
  }
  const range = rollingDateRange(new Date(), config.timezone, config.uploadDays || 45);
  return {
    results,
    changed: results.some((result) => result.changedFiles > 0),
    buckets: aggregateDailyBuckets(state, range),
    range,
    unknownModels: [...new Set(results.flatMap((result) => [...result.unknownModels]))],
  };
}
