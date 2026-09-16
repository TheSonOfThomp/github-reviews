import { describe, it, expect, beforeEach, vi } from "vitest";
import { createChromeMock } from "../mocks/chrome";
import { makeResponse } from "../mocks/fetch";
import { CACHE_STORAGE_KEY, type CacheEntry } from "../../src/background/reviewCache";

// Each stub PR both requests a review from octocat and is authored by
// octocat, so it passes both the review and mine filters.
const PRS = [
  { id: 1, number: 1, title: "PR 1", user: { login: "octocat", avatar_url: "" }, requested_reviewers: [{ login: "octocat" }] },
  { id: 2, number: 2, title: "PR 2", user: { login: "octocat", avatar_url: "" }, requested_reviewers: [{ login: "octocat" }] },
];

/** Mock fetch for the /user and /repos/.../pulls endpoints the background hits. */
function stubGithubApi() {
  return vi.fn(async (url: string) => {
    if (url === "https://api.github.com/user") {
      return makeResponse({ body: { login: "octocat" } });
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      return makeResponse({ body: PRS });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

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

describe("initial settings load", () => {
  it("fetches with stored settings, updates the badge, and primes the cache", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
    });

    await importBackground();

    await vi.waitFor(() => {
      expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    });
    await vi.waitFor(() => {
      const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
      expect(cache?.review?.prs).toHaveLength(2);
      expect(cache?.review?.repos).toEqual(["acme/widgets"]);
    });
  });

  it("clears the badge and fetches nothing when settings are empty", async () => {
    chromeMock = createChromeMock();

    await importBackground();
    await flush();

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runtime messages", () => {
  it("responds to GET_PULL_REQUESTS with PRs and writes them to the cache", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
    });
    await importBackground();
    await flush(); // let the initial settings load settle

    const response = (await chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" })) as {
      action: string;
      payload: typeof PRS;
      errors: unknown[];
    };

    expect(response.action).toBe("PULL_REQUESTS");
    expect(response.payload).toHaveLength(2);
    expect(response.errors).toEqual([]);
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
    expect(cache?.review?.prs).toHaveLength(2);
  });

  it("responds to GET_MY_PULL_REQUESTS and caches under the mine key", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
    });
    await importBackground();
    await flush();

    const response = (await chromeMock.__sendMessage({ action: "GET_MY_PULL_REQUESTS" })) as {
      action: string;
    };

    expect(response.action).toBe("MY_PULL_REQUESTS");
    await vi.waitFor(() => {
      const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
      expect(cache?.mine?.prs).toHaveLength(2);
    });
  });

  it("does not serve a message with partial settings; awaits the startup load (cold-start race)", async () => {
    const goodEntry: CacheEntry = {
      prs: PRS as never,
      errors: [],
      repos: ["acme/widgets"],
      fetchedAt: 1234,
    };
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
      local: { [CACHE_STORAGE_KEY]: { review: goodEntry } },
      deferSyncGet: true, // service worker cold start: settings load pending
    });
    await importBackground();

    // Message sent while settings are still unloaded: the handler must NOT
    // respond with an empty fetch. It awaits settingsReady, so the response
    // arrives only after the settings load completes — with correct data.
    const responsePromise = chromeMock.__sendMessage({ action: "GET_PULL_REQUESTS" }) as Promise<{
      payload: unknown[];
    }>;
    await flush();
    await flush();
    // Still pending: no empty response was served while settings unloaded
    // (the promise would have resolved by now if it had).

    // Now let the deferred settings load complete
    chromeMock.__flushSyncGet();
    const response = await responsePromise;

    expect(response.payload).toHaveLength(2);
    // The fetch used the fully-loaded username, and the cache write was
    // correct (not the empty-settings clobber the race used to produce)
    await vi.waitFor(() => {
      const cache = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
      expect(cache?.review?.prs).toHaveLength(2);
      expect(cache?.review?.fetchedAt).not.toBe(1234);
    });
  });
});

describe("settings changes", () => {
  it("clears the cache and refetches the user when the token changes", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
    });
    await importBackground();
    await vi.waitFor(() => {
      expect(chromeMock.__stores.local[CACHE_STORAGE_KEY]).toBeDefined();
    });

    chromeMock.storage.sync.set({ githubToken: "token-2" });

    await vi.waitFor(() => {
      expect(chromeMock.storage.local.remove).toHaveBeenCalledWith(
        CACHE_STORAGE_KEY,
        expect.anything()
      );
    });
    // username refetched with the new token and the cache re-primed
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer token-2" }),
        })
      );
      expect(chromeMock.__stores.local[CACHE_STORAGE_KEY]).toBeDefined();
    });
  });

  it("clears the cache when repos change", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
    });
    await importBackground();
    await vi.waitFor(() => {
      expect(chromeMock.__stores.local[CACHE_STORAGE_KEY]).toBeDefined();
    });

    chromeMock.storage.sync.set({ repos: ["acme/gadgets"] });

    await vi.waitFor(() => {
      expect(chromeMock.storage.local.remove).toHaveBeenCalledWith(
        CACHE_STORAGE_KEY,
        expect.anything()
      );
    });
  });
});

describe("polling alarm", () => {
  it("refreshes PRs and the badge when the alarm fires", async () => {
    chromeMock = createChromeMock({
      sync: { githubToken: "token", repos: ["acme/widgets"] },
    });
    await importBackground();
    await flush();
    chromeMock.action.setBadgeText.mockClear();

    chromeMock.__fireAlarm("poll-pull-requests");

    await vi.waitFor(() => {
      expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    });
    expect(chromeMock.alarms.create).toHaveBeenCalledWith("poll-pull-requests", {
      periodInMinutes: 5,
    });
  });
});
