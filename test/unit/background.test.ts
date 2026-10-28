import { describe, it, expect, beforeEach, vi } from "vitest";
import { createChromeMock } from "../mocks/chrome";
import { makeResponse } from "../mocks/fetch";
import { CACHE_STORAGE_KEY, type CacheEntry } from "../../src/background/reviewCache";

// The Search API filters server-side, so the same stub items serve both
// the review and mine searches.
const PRS = [
  { id: 1, number: 1, title: "PR 1", user: { login: "octocat", avatar_url: "" } },
  { id: 2, number: 2, title: "PR 2", user: { login: "octocat", avatar_url: "" } },
];

/** Mock fetch for the /user and /search/issues endpoints the background hits. */
function stubGithubApi() {
  return vi.fn(async (url: string) => {
    if (url === "https://api.github.com/user") {
      return makeResponse({ body: { login: "octocat" } });
    }
    if (url.startsWith("https://api.github.com/search/issues")) {
      return makeResponse({ body: { total_count: PRS.length, incomplete_results: false, items: PRS } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Qualifiers (e.g. `review-requested:octocat`) of every Search API call so far. */
const searchQualifiers = () =>
  fetchMock.mock.calls
    .map(([url]) => url as string)
    .filter((url) => url.startsWith("https://api.github.com/search/issues"))
    .map((url) => new URL(url).searchParams.get("q")!.split(" ").pop());

const flush = () => new Promise((resolve) => setImmediate(resolve));

let chromeMock: ReturnType<typeof createChromeMock>;
let fetchMock: ReturnType<typeof vi.fn>;

async function importBackground() {
  vi.stubGlobal("chrome", chromeMock);
  vi.stubGlobal("fetch", fetchMock);
  return await import("../../src/background/background");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  delete process.env.DEMO_MODE;
  // The background logs on every lifecycle event; keep test output clean
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = stubGithubApi();
});

describe("refresh triggers", () => {
  it("restores the cached badge without a startup fetch, then refreshes both lists on the alarm", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
      local: { githubUsername: "octocat", [CACHE_STORAGE_KEY]: { review: { prs: PRS, errors: [], repos: ["acme/widgets"], fetchedAt: Date.now() } } },
    });
    await importBackground();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    expect(chromeMock.alarms.create).toHaveBeenCalledWith("poll-pull-requests", { periodInMinutes: 5 });
    chromeMock.__fireAlarm("poll-pull-requests");
    await vi.waitFor(() => expect(searchQualifiers()).toHaveLength(2));
    expect(searchQualifiers()).toEqual(["review-requested:octocat", "author:octocat"]);
  });

  it("fetches both lists and caches them at the same timestamp on request", async () => {
    chromeMock = createChromeMock({ sync: { githubToken: "token", repos: ["acme/widgets"] } });
    await importBackground();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    const response = await chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" }) as {
      action: string; review: { prs: unknown[] }; mine: { prs: unknown[] };
    };
    expect(response.action).toBe("PULL_REQUESTS");
    expect(response.review.prs).toHaveLength(2);
    expect(response.mine.prs).toHaveLength(2);
    expect(searchQualifiers()).toEqual(["review-requested:octocat", "author:octocat"]);
    const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
    expect(cache.review.fetchedAt).toBe(cache.mine.fetchedAt);
    expect(cache.mine.repos).toEqual(["acme/widgets"]);
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
  });

  it("waits for settings on cold-start messages", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] }, deferSyncGet: true,
    });
    await importBackground();
    const response = chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    chromeMock.__flushSyncGet();
    expect((await response as { review: { prs: unknown[] } }).review.prs).toHaveLength(2);
  });

  it("coalesces concurrent popup requests and refreshes both lists again on the next request", async () => {
    chromeMock = createChromeMock({ sync: { githubToken: "token", repos: ["acme/widgets"] }, local: { githubUsername: "octocat" } });
    await importBackground();
    const [first, second] = await Promise.all([
      chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" }),
      chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" }),
    ]);
    expect(first).toEqual(second);
    expect(searchQualifiers()).toHaveLength(2);
    await chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" });
    expect(searchQualifiers()).toHaveLength(4);
  });

  it("debounces settings changes, then fetches and caches both lists", async () => {
    chromeMock = createChromeMock({ sync: { githubToken: "token", repos: ["acme/widgets"] }, local: { githubUsername: "octocat" } });
    await importBackground();
    await chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" });
    chromeMock.storage.sync.set({ repos: ["acme/gadgets"] });
    chromeMock.storage.sync.set({ includeTeamRequests: false });
    await vi.waitFor(() => expect(chromeMock.__stores.local[CACHE_STORAGE_KEY]).toBeUndefined());
    expect(searchQualifiers()).toHaveLength(2);
    await vi.waitFor(() => expect(searchQualifiers()).toHaveLength(4), { timeout: 2_000 });
    expect(searchQualifiers()).toEqual([
      "review-requested:octocat", "author:octocat",
      "user-review-requested:octocat", "author:octocat",
    ]);
    const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
    expect(cache.review.repos).toEqual(["acme/gadgets"]);
    expect(cache.mine.repos).toEqual(["acme/gadgets"]);
  });

  it("resolves a new token's username before the debounced fetch", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
      local: { githubUsername: "old-user" },
    });
    await importBackground();
    chromeMock.storage.sync.set({ githubToken: "token-2" });
    await vi.waitFor(() => expect(searchQualifiers()).toHaveLength(2), { timeout: 2_000 });
    expect(searchQualifiers()).toEqual(["review-requested:octocat", "author:octocat"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token-2" }) })
    );
    expect(chromeMock.__stores.local.githubUsername).toBe("octocat");
  });

  it("does not let an in-flight old-repo fetch replace the new cache", async () => {
    chromeMock = createChromeMock({ sync: { githubToken: "token", repos: ["acme/widgets"] }, local: { githubUsername: "octocat" } });
    await importBackground();
    let release!: () => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("acme%2Fwidgets")) return new Promise((resolve) => {
        release = () => resolve(makeResponse({ body: { total_count: 0, incomplete_results: false, items: [] } }));
      });
      return Promise.resolve(makeResponse({ body: { total_count: PRS.length, incomplete_results: false, items: PRS } }));
    });
    const old = chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" });
    await vi.waitFor(() => expect(release).toBeDefined());
    chromeMock.storage.sync.set({ repos: ["acme/gadgets"] });
    await vi.waitFor(() => expect(chromeMock.__stores.local[CACHE_STORAGE_KEY]).toBeUndefined());
    const fresh = await chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" });
    expect(fresh).toBeDefined();
    release();
    await flush();
    const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
    expect(cache.review.repos).toEqual(["acme/gadgets"]);
    expect(cache.mine.repos).toEqual(["acme/gadgets"]);
    void old; // superseded requests intentionally do not respond
  });
});
