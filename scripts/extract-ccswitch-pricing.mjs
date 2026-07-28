import fs from "node:fs";
import path from "node:path";

const [sourceFile, outputFile] = process.argv.slice(2);
if (!sourceFile || !outputFile) {
  throw new Error("Usage: node extract-ccswitch-pricing.mjs <schema.rs> <pricing.json>");
}

const source = fs.readFileSync(sourceFile, "utf8");
const marker = "let pricing_data = [";
const start = source.indexOf(marker);
const end = source.indexOf("\n        ];", start);
if (start < 0 || end < 0) throw new Error("Unable to locate CC Switch pricing_data.");

const section = source.slice(start + marker.length, end);
const tuple = /\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,?\s*\)/gs;
const models = [...section.matchAll(tuple)].map((match) => ({
  model: match[1],
  displayName: match[2],
  input: match[3],
  output: match[4],
  cacheRead: match[5],
  cacheCreation: match[6],
}));
if (models.length < 50) throw new Error(`Only found ${models.length} pricing rows.`);

models.sort((left, right) => left.model.localeCompare(right.model));
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(
  outputFile,
  `${JSON.stringify({ source: "CC Switch 3.18.0", models }, null, 2)}\n`,
  "utf8",
);
console.log(`Wrote ${models.length} pricing rows to ${outputFile}`);
