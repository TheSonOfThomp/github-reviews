import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: __dirname,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    [process.env.CI ? "github" : "list"],
    // Machine-readable results — the source for which screenshots CI
    // publishes (tests flagged with the comment-screenshot annotation).
    // Pinned absolute: the JSON reporter resolves outputFile relative to
    // the config dir, while test artifacts land in <repo>/test-results.
    ["json", { outputFile: path.resolve(__dirname, "../test-results/report.json") }],
  ],
  globalSetup: "./global-setup",
  projects: [
    // Both projects share the fixtures; the context fixture reads the
    // project name to pick prefers-color-scheme. Doubles the screenshots
    // posted to the PR (light + dark).
    { name: "light" },
    { name: "dark" },
  ],
  use: {
    trace: "on-first-retry",
    // A PNG per test; only tests annotated with comment-screenshot are
    // published to the PR by CI (see e2e/scripts/flagged-screenshots.mjs)
    screenshot: "on",
  },
});
