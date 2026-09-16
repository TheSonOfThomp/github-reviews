import { test as base, chromium } from "@playwright/test";
import type { Page, Worker, ChromiumBrowserContext } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { GitHubStubServer } from "../stub/server";

const EXTENSION_PATH = path.resolve(__dirname, "../../build");

/**
 * The extension's service worker, or a promise for it once Chrome starts it.
 */
async function extensionServiceWorker(context: ChromiumBrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: 10_000 });
}

type Fixtures = {
  /** Per-test local HTTPS stand-in for api.github.com (one per browser context). */
  stub: GitHubStubServer;
  /** A browser context with the built extension loaded (fresh profile per test). */
  context: ChromiumBrowserContext;
  /** The extension's service worker — evaluate() here runs inside it. */
  sw: Worker;
  extensionId: string;
  /** Opens the popup UI as a regular tab and returns the page. */
  openPopup: () => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  stub: async ({}, use) => {
    const stub = new GitHubStubServer();
    await stub.start();
    await use(stub);
    await stub.stop();
  },
  context: async ({ stub }, use, testInfo) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "github-reviews-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // The default headless *shell* cannot load extensions — channel
      // "chromium" selects full Chromium in the new headless mode.
      headless: true,
      channel: "chromium",
      // Match the popover's real chrome: 360px wide, Chrome's 600px popup max
      viewport: { width: 360, height: 600 },
      // "light"/"dark" projects — Primer's colorMode="auto" follows it
      colorScheme: testInfo.project.name === "dark" ? "dark" : "light",
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        // Route all GitHub API + demo avatar traffic to the local stub
        `--host-resolver-rules=MAP api.github.com 127.0.0.1:${stub.port}, MAP i.pravatar.cc 127.0.0.1:${stub.port}`,
        "--ignore-certificate-errors",
      ],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    // launchPersistentContext opens with a blank initial tab; close it so
    // Playwright's per-test screenshot captures only the popup page
    for (const page of context.pages()) await page.close();
    await use(await extensionServiceWorker(context));
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  openPopup: async ({ context, extensionId }, use) => {
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/index.html`);
      return page;
    });
  },
});

export { expect } from "@playwright/test";

/**
 * Flag the current test's screenshots for publishing to the PR comment
 * (see e2e/scripts/flagged-screenshots.mjs and the CI publish step).
 * Call as the first line of the test body.
 */
export const commentScreenshot = () => {
  test.info().annotations.push({ type: "comment-screenshot" });
};
