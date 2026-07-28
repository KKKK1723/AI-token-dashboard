import fs from "node:fs";

const SCALE = 1_000_000_000_000n;
const MILLION = 1_000_000n;
let defaultCatalog;

function parseDecimalScaled(value, scale = SCALE) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`Invalid decimal price: ${value}`);
  const [whole, fraction = ""] = text.split(".");
  const digits = scale.toString().length - 1;
  if (fraction.length > digits) throw new Error(`Price has too much precision: ${value}`);
  return BigInt(whole) * scale + BigInt((fraction + "0".repeat(digits)).slice(0, digits));
}

function loadDefaultCatalog() {
  if (defaultCatalog) return defaultCatalog;
  const raw = JSON.parse(
    fs.readFileSync(new URL("../data/pricing.json", import.meta.url), "utf8"),
  );
  defaultCatalog = new Map(raw.models.map((entry) => [entry.model, entry]));
  defaultCatalog.set("codex-auto-review", {
    model: "codex-auto-review",
    displayName: "Codex Auto Review",
    input: "0",
    output: "0",
    cacheRead: "0",
    cacheCreation: "0",
  });
  return defaultCatalog;
}

function stripDateSuffix(model) {
  if (/-\d{4}-\d{2}-\d{2}$/.test(model)) return model.slice(0, -11);
  const compact = model.match(/^(.*)-(\d{8})$/);
  if (compact) return compact[1];
  const short = model.match(/^(.*)-(\d{2})(\d{2})(\d{2})$/);
  if (short) {
    const month = Number(short[3]);
    const day = Number(short[4]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return short[1];
  }
  return null;
}

function modelCandidates(modelId) {
  const raw = String(modelId || "")
    .split("/")
    .at(-1)
    .split(":")[0]
    .trim()
    .replaceAll("@", "-")
    .toLowerCase();
  if (!raw || ["unknown", "null", "none"].includes(raw)) return [];
  const candidates = [];
  const queue = [raw];
  const nonAnthropic = [
    "abab", "ark-code", "arctic", "astron", "codex", "command-r", "deepseek",
    "doubao", "ernie", "gemini", "gemma", "glm", "gpt", "grok", "hermes",
    "hy3", "hunyuan", "jamba", "kimi", "lfm", "llama", "longcat", "mercury",
    "mimo", "minimax", "mistral", "mixtral", "moonshot", "nemotron", "nova-",
    "openai", "qianfan", "qwen", "seed-", "solar", "stepfun",
  ];
  while (queue.length) {
    const candidate = queue.pop();
    if (!candidate || candidates.includes(candidate)) continue;
    candidates.push(candidate);
    const claudeAt = candidate.lastIndexOf("claude-");
    if (claudeAt > 0) queue.push(candidate.slice(claudeAt));
    for (const prefix of ["openai.", "anthropic.", "google.", "moonshot.", "moonshotai.", "bedrock.", "global."]) {
      if (candidate.startsWith(prefix)) queue.push(candidate.slice(prefix.length));
    }
    if (candidate.startsWith("claude-") && nonAnthropic.some((prefix) => candidate.slice(7).startsWith(prefix))) {
      queue.push(candidate.slice(7));
    }
    const bedrock = candidate.match(/^(.*)-v\d+$/);
    if (bedrock) queue.push(bedrock[1]);
    const withoutDate = stripDateSuffix(candidate);
    if (withoutDate) queue.push(withoutDate);
    for (const suffix of ["-minimal", "-low", "-medium", "-high", "-xhigh"]) {
      if (candidate.endsWith(suffix)) queue.push(candidate.slice(0, -suffix.length));
    }
    if (candidate.startsWith("claude-") && candidate.includes(".")) {
      queue.push(candidate.replaceAll(".", "-"));
    }
  }
  return candidates;
}

function allowPrefixMatch(model) {
  const dashes = [...model].filter((character) => character === "-").length;
  if (model.startsWith("claude-")) return dashes >= 3;
  if (["o1", "o3", "o4", "o5"].some((prefix) => model.startsWith(prefix))) return dashes >= 1;
  return ["gpt-", "gemini-", "deepseek-", "qwen-", "glm-", "kimi-", "minimax-"]
    .some((prefix) => model.startsWith(prefix)) && dashes >= 2;
}

export function createPricingCatalog(overrides = {}) {
  const catalog = new Map(loadDefaultCatalog());
  for (const [model, value] of Object.entries(overrides)) {
    catalog.set(model.toLowerCase(), { model: model.toLowerCase(), ...value });
  }
  return catalog;
}

export function findPricing(catalog, modelId) {
  const candidates = modelCandidates(modelId);
  for (const candidate of candidates) {
    if (catalog.has(candidate)) return catalog.get(candidate);
  }
  const keys = [...catalog.keys()];
  for (const candidate of candidates) {
    if (!allowPrefixMatch(candidate)) continue;
    const match = keys
      .filter((key) => key.startsWith(`${candidate}-`))
      .sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
    if (match) return catalog.get(match);
  }
  return null;
}

function componentCost(tokens, rate) {
  return (BigInt(tokens) * parseDecimalScaled(rate)) / MILLION;
}

export function calculateCostPicos(record, catalog) {
  const pricing = findPricing(catalog, record.model);
  if (!pricing) return { costPicos: "0", unknownModel: record.model };
  const cost =
    componentCost(record.inputTokens, pricing.input) +
    componentCost(record.outputTokens, pricing.output) +
    componentCost(record.cacheReadTokens, pricing.cacheRead) +
    componentCost(record.cacheCreationTokens, pricing.cacheCreation);
  return { costPicos: cost.toString(), unknownModel: null };
}

export function picosToDecimal(value) {
  const amount = BigInt(value);
  const whole = amount / SCALE;
  const fraction = (amount % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
