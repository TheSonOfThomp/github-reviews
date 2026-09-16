#!/usr/bin/env node
/**
 * Selection logic for PR-comment screenshots: walks the Playwright JSON
 * report and returns the screenshot attachments of every test annotated
 * with `comment-screenshot`, grouped so light/dark variants pair up.
 *
 * Run directly, it prints the selected attachment paths (one per line).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ANNOTATION_TYPE = "comment-screenshot";

export function flaggedScreenshots(reportPath = "test-results/report.json") {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  const out = [];
  const visitSuite = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const flagged = (test.annotations ?? []).some((a) => a.type === ANNOTATION_TYPE);
        if (!flagged) continue;
        for (const result of test.results ?? []) {
          for (const attachment of result.attachments ?? []) {
            if (attachment.path && attachment.name === "screenshot") {
              const dir = path.basename(path.dirname(attachment.path));
              const kind = path.basename(attachment.path, ".png");
              const variant = dir.endsWith("-light")
                ? "light"
                : dir.endsWith("-dark")
                  ? "dark"
                  : null;
              out.push({
                dir,
                variant,
                key: variant ? dir.slice(0, -variant.length - 1) : dir,
                kind,
                path: attachment.path,
              });
            }
          }
        }
      }
    }
    for (const child of suite.suites ?? []) visitSuite(child);
  };
  for (const suite of report.suites ?? []) visitSuite(suite);
  return out;
}

// CLI: print the selected paths
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv[2] ?? "test-results/report.json";
  const paths = flaggedScreenshots(reportPath).map((s) => s.path);
  process.stdout.write(paths.join("\n") + (paths.length ? "\n" : ""));
}
