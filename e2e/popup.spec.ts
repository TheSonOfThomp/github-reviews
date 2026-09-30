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

/**
 * Wait until the popup is showing the PRs from the given view-mode's cache
 * entry (the list caps at 10 per repo), and return that entry. Tolerates
 * the stale-while-revalidate paint: the settled state is when the visible
 * list matches the freshest cache write.
 */
async function settledEntry(page: Page, key: "review" | "mine"): Promise<CacheEntry> {
  let entry: CacheEntry | undefined;
  await expect
    .poll(async () => {
      const cache = await readCache(page);
      entry = cache?.[key];
      if (!entry || entry.prs.length === 0) return false;
      const visible = await page.locator("a[title^='#']").count();
      return visible === Math.min(entry.prs.length, 10);
    })
    .toBe(true);
  return entry!;
}

test("popup shows the no-token guard when no settings are configured", async ({ openPopup }) => {
  const page = await openPopup();

  await expect(page.getByText("No GitHub token set.")).toBeVisible();
  await expect(page.locator("a[title^='#']")).toHaveCount(0);
});

test("renders demo-data PRs and writes them to the cache", async ({ openPopup, stub }) => {
  const page = await openPopup();
  await seedSettings(page, SETTINGS);
  await page.reload();

  await expect(page.getByText("acme/widgets")).toBeVisible();
  const entry = await settledEntry(page, "review");

  expect(entry.errors).toEqual([]);
  expect(entry.repos).toEqual(["acme/widgets"]);
  // The review view searched server-side for the demo user's review requests
  expect(entry.prs.length).toBeGreaterThan(0);
  expect(stub.searchQueries).toContain("repo:acme/widgets is:pr is:open review-requested:demo-user");

  for (const pr of entry.prs.slice(0, 3)) {
    await expect(page.getByRole("link", { name: new RegExp(`^#${pr.number} `) })).toBeVisible();
  }
});

test("renders the cached list first, then revalidates in the background", async ({
  openPopup,
  stub,
}) => {
  const page = await openPopup();
  await seedSettings(page, SETTINGS);
  await page.reload();

  const firstPr = page.locator("a[title^='#']").first();
  await expect(firstPr).toBeVisible();
  const cachedTitle = await firstPr.getAttribute("title");
  expect(cachedTitle).toMatch(/^#\d+ /);

  // Serve a different PR set next, and slow it down so the cached render is
  // observable
  stub.generation++;
  stub.delayMs = 1500;
  await page.reload();

  // The previous fetch's cache entry paints immediately — well before the
  // delayed fresh response can land (stale-while-revalidate)
  await expect(page.locator(`a[title="${cachedTitle}"]`)).toBeVisible({ timeout: 1000 });
  stub.delayMs = 0;

  // Once the fresh response arrives (a new seeded batch) it replaces the
  // cached content
  await expect(firstPr).not.toHaveAttribute("title", cachedTitle!, { timeout: 10_000 });
});

test(
  "clears the cache when repos change, then renders the new repo",
  // comment-screenshot: publish this test's screenshots to the PR comment
  { annotation: { type: "comment-screenshot" } },
  async ({ openPopup, stub }) => {
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
  }
);

test(
  "switching to My Open PRs shows PRs authored by the user",
  // comment-screenshot: publish this test's screenshots to the PR comment
  { annotation: { type: "comment-screenshot" } },
  async ({ openPopup }) => {
    const page = await openPopup();
    await seedSettings(page, SETTINGS);
    await page.reload();
    const review = await settledEntry(page, "review");

    await page.getByRole("button", { name: "My Open PRs" }).click();

    const mine = await settledEntry(page, "mine");
    // The real mine filter ran: every cached PR is authored by the demo user
    expect(mine.prs.every((pr) => pr.user.login === "demo-user")).toBe(true);
    // And it is a different set from the review view
    const reviewNumbers = new Set(review.prs.map((pr) => pr.number));
    expect(mine.prs.some((pr) => !reviewNumbers.has(pr.number))).toBe(true);
  }
);

test(
  "turning off team requests on the options page narrows the Review list to direct requests",
  // comment-screenshot: publish this test's screenshots to the PR comment
  { annotation: { type: "comment-screenshot" } },
  async ({ openPopup, stub, extensionId }) => {
    const page = await openPopup();
    await seedSettings(page, SETTINGS);
    await page.reload();
    const withTeams = await settledEntry(page, "review");
    // Default: the Review search includes team requests
    expect(stub.searchQueries).toContain("repo:acme/widgets is:pr is:open review-requested:demo-user");

    // Flip the switch through the real options UI (same tab, so the final
    // screenshot is the popup)
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const toggle = page.getByRole("button", { name: "Include PRs requested from my teams" });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Hold the post-change refetch back so the cleared state is observable
    stub.delayMs = 2000;
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // The setting change invalidated the cache
    await expect.poll(async () => await readCache(page), { timeout: 1_500 }).toBe(null);
    stub.delayMs = 0;

    await page.goto(`chrome-extension://${extensionId}/index.html`);
    const directOnly = await settledEntry(page, "review");

    // The refetch searched for direct requests only
    const reviewQueries = stub.searchQueries.filter((q) => !q.includes("author:"));
    expect(reviewQueries.at(-1)).toBe("repo:acme/widgets is:pr is:open user-review-requested:demo-user");

    // The stub serves the same PR set for every search, so the direct-only
    // list is a strict subset: the team-only PRs are gone, the rest remain
    const directIds = new Set(directOnly.prs.map((pr) => pr.id));
    const teamOnly = withTeams.prs.filter((pr) => !directIds.has(pr.id));
    expect(teamOnly.length).toBeGreaterThan(0);
    expect(withTeams.prs.map((pr) => pr.id)).toEqual(expect.arrayContaining([...directIds]));
    for (const pr of teamOnly) {
      await expect(page.getByRole("link", { name: new RegExp(`^#${pr.number} `) })).toBeHidden();
    }
    for (const pr of directOnly.prs.slice(0, 3)) {
      await expect(page.getByRole("link", { name: new RegExp(`^#${pr.number} `) })).toBeVisible();
    }
  }
);

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

const pullsUrl = (repo: string, qualifier: string) =>
  `https://github.com/${repo}/pulls?q=${encodeURIComponent(`is:pr is:open ${qualifier}:demo-user`)}`;

test(
  "repo headers link to GitHub's PR list filtered to the active view",
  // comment-screenshot: publish this test's screenshots to the PR comment
  { annotation: { type: "comment-screenshot" } },
  async ({ openPopup }) => {
    const page = await openPopup();
    await seedSettings(page, SETTINGS);
    await page.reload();
    // Reload once the SW has persisted the username so the header uses it, not @me
    await expect
      .poll(() =>
        page.evaluate(
          () => new Promise((resolve) => chrome.storage.local.get(["githubUsername"], (s) => resolve(s.githubUsername)))
        )
      )
      .toBe("demo-user");
    await page.reload();

    const review = await settledEntry(page, "review");
    const header = page.getByRole("link", { name: "acme/widgets", exact: true });
    await expect(header).toHaveAttribute("href", pullsUrl("acme/widgets", "review-requested"));
    await expect(header).toHaveAttribute("target", "_blank");
    if (review.prs.length > 10) {
      await expect(page.getByRole("link", { name: /more — view all on GitHub/ })).toHaveAttribute(
        "href",
        pullsUrl("acme/widgets", "review-requested")
      );
    }

    await page.getByRole("button", { name: "My Open PRs" }).click();
    await settledEntry(page, "mine");
    await expect(header).toHaveAttribute("href", pullsUrl("acme/widgets", "author"));
  }
);

test("errored repos render a plain-text header", async ({ openPopup }) => {
  const page = await openPopup();
  await seedSettings(page, { ...SETTINGS, repos: ["acme/sso-org"] });
  await page.reload();

  await expect(page.getByText("SSO authorization required for acme/sso-org")).toBeVisible();
  await expect(page.getByText("acme/sso-org", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "acme/sso-org", exact: true })).toHaveCount(0);
});
