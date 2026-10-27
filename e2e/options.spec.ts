import { test, expect } from "./fixtures/extension";
import type { Page } from "@playwright/test";

const syncSettings = (page: Page) =>
  page.evaluate(
    () => new Promise<Record<string, unknown>>((resolve) => chrome.storage.sync.get(resolve))
  );

test(
  "settings page shows configured repos and links out to GitHub",
  // comment-screenshot: publish this test's screenshots to the PR comment
  { annotation: { type: "comment-screenshot" } },
  async ({ context, extensionId }) => {
    // A page-sized layout instead of the popup's 360x600 chrome
    const page = await context.newPage();
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.evaluate(
      (items) => new Promise<void>((resolve) => chrome.storage.sync.set(items, resolve)),
      { githubToken: "stub-token", repos: ["acme/widgets", "acme/gadgets"] }
    );
    await page.reload();

    await expect(page.getByRole("heading", { name: "GitHub Reviews — Settings" })).toBeVisible();
    await expect(page.getByText("acme/widgets", { exact: true })).toBeVisible();
    await expect(page.getByText("acme/gadgets", { exact: true })).toBeVisible();

    // Per-repo buttons open that repo's PR list (#35)
    for (const repo of ["acme/widgets", "acme/gadgets"]) {
      await expect(page.getByRole("link", { name: `Open ${repo} on GitHub` })).toHaveAttribute(
        "href",
        `https://github.com/${repo}/pulls`
      );
    }
    // The footer button opens the extension's own repository (#35)
    await expect(page.getByRole("link", { name: "Open this repo on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/TheSonOfThomp/github-reviews"
    );
  }
);

test("saves a token only when its field loses focus", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  const token = page.getByLabel("GitHub Personal Access Token");
  await token.fill("ghp_new-token");
  expect((await syncSettings(page)).githubToken).not.toBe("ghp_new-token");

  await token.blur();
  await expect.poll(async () => (await syncSettings(page)).githubToken).toBe("ghp_new-token");
});
