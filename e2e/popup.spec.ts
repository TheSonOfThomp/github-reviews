import { test, expect } from "./fixtures/extension";
import type { Page } from "@playwright/test";
import type { CacheEntry } from "../src/background/reviewCache";

const SETTINGS = { githubToken: "stub-token", repos: ["acme/widgets"] };

/** Write chrome.storage.sync settings from inside an extension page. */
const seedSettings = (page: Page, settings: Record<string, unknown>) =>
  page.evaluate(
    (items) => new Promise<void>((resolve) => chrome.storage.sync.set(items, resolve)),
    settings
  );

/** Read the prCache blob out of chrome.storage.local from inside an extension page. */
const readCache = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, CacheEntry> | null>((resolve) =>
        chrome.storage.local.get(["prCache"], (stored) =>
          resolve((stored["prCache"] as Record<string, CacheEntry>) ?? null)
        )
      )
  );

test("popup shows the no-token guard when no settings are configured", async ({ openPopup }) => {
  const page = await openPopup();

  await expect(page.getByText("No GitHub token set.")).toBeVisible();
  await expect(page.getByRole("link", { name: /^#1 / })).toBeHidden();
});

test("renders stubbed PRs and writes them to the cache", async ({ openPopup }) => {
  const page = await openPopup();
  await seedSettings(page, SETTINGS);
  await page.reload();

  await expect(page.getByText("acme/widgets")).toBeVisible();
  await expect(page.getByRole("link", { name: /^#1 / })).toBeVisible();
  await expect(page.getByRole("link", { name: /^#2 / })).toBeVisible();
  // The mine-only PR (#13) is not shown in the review-requests view
  await expect(page.getByRole("link", { name: /^#13 / })).toBeHidden();

  // #8 cache behavior: the fetch result lands in chrome.storage.local
  const cache = await readCache(page);
  expect(cache?.review?.prs).toHaveLength(2);
  expect(cache?.review?.repos).toEqual(["acme/widgets"]);
});

test("renders the cached list first, then revalidates in the background", async ({
  openPopup,
  stub,
}) => {
  const page = await openPopup();
  await seedSettings(page, SETTINGS);
  await page.reload();

  const firstPr = page.locator("a[title^='#1']");
  await expect(firstPr).toBeVisible();
  const cachedTitle = await firstPr.getAttribute("title");
  expect(cachedTitle).toContain("Batch");

  // Slow the fresh fetch down so the cached render is observable
  stub.delayMs = 1500;
  await page.reload();

  // The previous fetch's cache entry paints immediately — well before the
  // delayed fresh response can land (stale-while-revalidate)
  await expect(page.locator(`a[title="${cachedTitle}"]`)).toBeVisible({ timeout: 1000 });
  stub.delayMs = 0;

  // Once the fresh response arrives it replaces the cached content
  await expect(firstPr).not.toHaveAttribute("title", cachedTitle!, { timeout: 10_000 });
});

test("clears the cache when repos change, then renders the new repo", async ({
  openPopup,
  stub,
}) => {
  const page = await openPopup();
  await seedSettings(page, SETTINGS);
  await page.reload();
  await expect(page.getByText("acme/widgets")).toBeVisible();
  await expect.poll(async () => (await readCache(page)) !== null).toBe(true);

  // Hold the post-change refetch back so the cleared state is observable
  stub.delayMs = 2000;
  await seedSettings(page, { repos: ["acme/gadgets"] });
  await expect.poll(async () => await readCache(page), { timeout: 1_500 }).toBe(null);

  stub.delayMs = 0;
  await page.reload();

  await expect(page.getByText("acme/gadgets")).toBeVisible();
  // The old repo's cached PRs must not render against the new settings
  await expect(page.getByText("acme/widgets")).toBeHidden();
});

test("switching to My Open PRs shows PRs authored by the user", async ({ openPopup }) => {
  const page = await openPopup();
  await seedSettings(page, SETTINGS);
  await page.reload();
  await expect(page.getByRole("link", { name: /^#1 / })).toBeVisible();

  await page.getByRole("button", { name: "My Open PRs" }).click();

  await expect(page.getByRole("link", { name: /^#13 / })).toBeVisible();
  await expect(page.getByRole("link", { name: /^#1 / })).toBeHidden();
});

test("surfaces the SSO authorization error for SSO-protected repos", async ({ openPopup }) => {
  const page = await openPopup();
  await seedSettings(page, { ...SETTINGS, repos: ["acme/sso-org"] });
  await page.reload();

  await expect(page.getByText("SSO authorization required for acme/sso-org")).toBeVisible();
  await expect(page.getByRole("link", { name: "Authorize SSO →" })).toHaveAttribute(
    "href",
    "https://github.com/orgs/acme/sso?token=abc123"
  );
});
