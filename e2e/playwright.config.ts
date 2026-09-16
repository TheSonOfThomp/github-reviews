import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./global-setup",
  use: {
    trace: "on-first-retry",
    // A PNG per test, published to the PR by CI (see .github/workflows/ci.yml)
    screenshot: "on",
  },
});
