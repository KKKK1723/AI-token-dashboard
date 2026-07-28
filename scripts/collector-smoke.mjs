import os from "node:os";
import path from "node:path";

import { collectClaudeUsage } from "../packages/cli/src/collectors/claude.js";
import { collectCodexUsage } from "../packages/cli/src/collectors/codex.js";
import { createPricingCatalog } from "../packages/cli/src/pricing.js";
import { aggregateDailyBuckets } from "../packages/cli/src/records.js";
import { createEmptyState } from "../packages/cli/src/storage.js";

const [start, end] = process.argv.slice(2);
if (!start || !end) throw new Error("Usage: node collector-smoke.mjs <start> <end>");

const state = createEmptyState();
const pricingCatalog = createPricingCatalog();
const common = { state, timezone: "Asia/Shanghai", pricingCatalog };
const claude = await collectClaudeUsage({
  ...common,
  claudeDirectory: path.join(os.homedir(), ".claude"),
});
const codex = await collectCodexUsage({
  ...common,
  codexDirectory: path.join(os.homedir(), ".codex"),
});
const buckets = aggregateDailyBuckets(state, { start, end });
const totals = {};
for (const bucket of buckets) {
  const target = (totals[bucket.source] ||= {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costPicos: 0n,
    models: {},
  });
  for (const field of [
    "requests",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
  ]) {
    target[field] += bucket[field];
  }
  target.costPicos += BigInt(bucket.costPicos);
  target.models[bucket.model] =
    (target.models[bucket.model] || 0) +
    bucket.inputTokens +
    bucket.outputTokens +
    bucket.cacheReadTokens +
    bucket.cacheCreationTokens;
}
for (const target of Object.values(totals)) target.costPicos = target.costPicos.toString();

console.log(
  JSON.stringify({
    claude: { ...claude, unknownModels: [...claude.unknownModels] },
    codex: { ...codex, unknownModels: [...codex.unknownModels] },
    totals,
  }),
);
