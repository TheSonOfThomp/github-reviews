#!/usr/bin/env node
/**
 * Prints the screenshot attachment paths of every test flagged with a
 * `comment-screenshot` annotation, one per line. CI uses this to decide
 * which E2E screenshots get published to the PR comment.
 *
 * Usage: node e2e/scripts/flagged-screenshots.mjs [report.json]
 *   (defaults to test-results/report.json)
 */
import fs from "node:fs";

const reportPath = process.argv[2] ?? "test-results/report.json";
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const visitSuite = (suite, out) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const flagged = (test.annotations ?? []).some((a) => a.type === "comment-screenshot");
      if (!flagged) continue;
      for (const result of test.results ?? []) {
        for (const attachment of result.attachments ?? []) {
          if (attachment.path && attachment.name === "screenshot") out.push(attachment.path);
        }
      }
    }
  }
  for (const child of suite.suites ?? []) visitSuite(child, out);
};

const paths = [];
for (const suite of report.suites ?? []) visitSuite(suite, paths);
process.stdout.write(paths.join("\n") + (paths.length ? "\n" : ""));
