#!/usr/bin/env node
/**
 * Builds the PR comment body for flagged E2E screenshots and copies the
 * selected PNGs into an output directory for CI to push to the
 * ci/e2e-screenshots branch.
 *
 * The comment renders one table row per flagged test, light and dark
 * variants side by side.
 *
 * Usage:
 *   node e2e/scripts/screenshot-comment.mjs \
 *     --run <run-id> --sha <commit-sha> \
 *     --raw-base https://raw.githubusercontent.com/<owner>/<repo>/ci/e2e-screenshots \
 *     [--report test-results/report.json] [--out /tmp/shots]
 */
import fs from "node:fs";
import path from "node:path";
import { flaggedScreenshots } from "./flagged-screenshots.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const runId = arg("--run");
const sha = arg("--sha") ?? "";
const rawBase = arg("--raw-base");
const reportPath = arg("--report", "test-results/report.json");
const outDir = arg("--out", "/tmp/shots");

if (!runId || !rawBase) {
  console.error("--run and --raw-base are required");
  process.exit(1);
}

const shots = flaggedScreenshots(reportPath);
fs.mkdirSync(outDir, { recursive: true });

// Copy each screenshot into the output dir under a flat, unique name
const fileName = (s) => `${s.dir}--${s.kind}.png`;
for (const s of shots) {
  fs.copyFileSync(s.path, path.join(outDir, fileName(s)));
}

if (shots.length === 0) process.exit(0);

// Group by test, pairing light/dark variants into table cells
const byKey = new Map();
for (const s of shots) {
  const entry = byKey.get(s.key) ?? {};
  entry[s.variant ?? "single"] = fileName(s);
  byKey.set(s.key, entry);
}

const cell = (name) => (name ? `![${path.basename(name, ".png")}](${rawBase}/${runId}/${name})` : "");

const lines = [
  "<!--e2e-screenshots-->",
  "### E2E screenshots",
  "",
  `Latest run: ${runId} at ${sha.slice(0, 7)}`,
  "",
  "| Light | Dark |",
  "| --- | --- |",
];
for (const [key, variants] of byKey) {
  lines.push(`| ${cell(variants.light)} | ${cell(variants.dark)} |`);
}
process.stdout.write(lines.join("\n") + "\n");
