import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
  searchUrl,
  type PullRequest,
} from "../../src/background/fetchPullRequests";
import { makeResponse } from "../mocks/fetch";

const pr = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  id: number,
  number,
  title: `PR #${number}`,
  html_url: `https://github.com/acme/widgets/pull/${number}`,
  user: { login: "someone-else", avatar_url: "" },
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  draft: false,
  repo: "",
  ...overrides,
});

const searchBody = (items: PullRequest[], total_count = items.length) => ({
  total_count,
  incomplete_results: false,
  items,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.DEMO_MODE;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("fetchAuthenticatedUser", () => {
  it("returns the login on success", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: { login: "octocat" } }));

    await expect(fetchAuthenticatedUser("token")).resolves.toBe("octocat");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      })
    );
  });

  it("throws with status when the response is not ok", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 401, statusText: "Unauthorized" })
    );

    await expect(fetchAuthenticatedUser("bad-token")).rejects.toThrow(
      "Failed to fetch authenticated user: 401 Unauthorized"
    );
  });
});

describe("guards", () => {
  it("returns empty results without fetching when no token is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchOpenPullRequests("", ["acme/widgets"], "octocat");

    expect(result).toEqual({ prs: [], errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[BACKGROUND] no GitHub token set");
    warn.mockRestore();
  });

  it("returns empty results without fetching when no repos are configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchOpenPullRequests("token", [], "octocat");

    expect(result).toEqual({ prs: [], errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[BACKGROUND] no repos configured");
    warn.mockRestore();
  });
});

describe("searchUrl", () => {
  it("builds an encoded Search API query scoped to the repo", () => {
    expect(searchUrl("acme/widgets", "review-requested:octocat")).toBe(
      "https://api.github.com/search/issues?q=repo%3Aacme%2Fwidgets%20is%3Apr%20is%3Aopen%20review-requested%3Aoctocat&per_page=100"
    );
  });
});

describe("fetchOpenPullRequests", () => {
  it("searches for review requests and tags results with the repo", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: searchBody([pr(1), pr(3)]) }));

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(fetchMock).toHaveBeenCalledWith(
      searchUrl("acme/widgets", "review-requested:octocat"),
      expect.anything()
    );
    expect(errors).toEqual([]);
    expect(prs.map((p) => p.number)).toEqual([1, 3]);
    expect(prs.every((p) => p.repo === "acme/widgets")).toBe(true);
  });

  it("returns empty results without fetching when no username is resolved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchOpenPullRequests("token", ["acme/widgets"], "");

    expect(result).toEqual({ prs: [], errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when more results match than one page returns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(makeResponse({ body: searchBody([pr(1)], 250) }));

    const { prs } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(prs).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("showing 1 of 250"));
    warn.mockRestore();
  });

  it("reports a plain API error for a failing repo without SSO header", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 500, statusText: "Internal Server Error" })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/broken"], "octocat");

    expect(prs).toEqual([]);
    expect(errors).toEqual([
      { repo: "acme/broken", message: "GitHub API error for acme/broken: 500 Internal Server Error" },
    ]);
  });

  it("reports a missing or inaccessible repo (422) as an access error", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 422, statusText: "Unprocessable Entity" })
    );

    const { errors } = await fetchOpenPullRequests("token", ["acme/missing"], "octocat");

    expect(errors).toEqual([
      { repo: "acme/missing", message: "Repo acme/missing not found, or your token lacks access to it" },
    ]);
  });

  it("reports the search rate limit with the retry delay", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000_000);
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_000_000 + 42) },
      })
    );

    const { errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(errors).toEqual([
      { repo: "acme/widgets", message: "GitHub search rate limit hit — retry in 42s" },
    ]);
    vi.restoreAllMocks();
  });

  it("extracts the SSO authorization URL from the X-GitHub-SSO header", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: { "X-GitHub-SSO": "required; url=https://github.com/orgs/acme/sso?abc=123" },
      })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/private"], "octocat");

    expect(prs).toEqual([]);
    expect(errors).toEqual([
      {
        repo: "acme/private",
        message: "SSO authorization required for acme/private",
        ssoAuthorizeUrl: "https://github.com/orgs/acme/sso?abc=123",
      },
    ]);
  });

  it("reports SSO when search silently drops results (partial-results header)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: searchBody([]),
        headers: { "X-GitHub-SSO": "partial-results; organizations=123,456" },
      })
    );

    const { errors } = await fetchOpenPullRequests("token", ["acme/private"], "octocat");

    expect(errors).toEqual([
      {
        repo: "acme/private",
        message: "SSO authorization required for acme/private",
        ssoAuthorizeUrl: "https://github.com/settings/tokens",
      },
    ]);
  });

  it("merges results across repos and surfaces a rejected fetch as a repo error", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === searchUrl("acme/ok", "review-requested:octocat")) {
        return makeResponse({ body: searchBody([pr(1)]) });
      }
      if (url === searchUrl("acme/failing", "review-requested:octocat")) {
        throw new Error("network down");
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { prs, errors } = await fetchOpenPullRequests(
      "token",
      ["acme/ok", "acme/failing"],
      "octocat"
    );

    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(errors).toEqual([
      { repo: "acme/failing", message: "Failed to fetch acme/failing: network down" },
    ]);
    error.mockRestore();
  });
});

describe("fetchMyOpenPullRequests", () => {
  it("searches for PRs authored by the user", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: searchBody([pr(1, { user: { login: "octocat", avatar_url: "" } })]) })
    );

    const { prs, errors } = await fetchMyOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(fetchMock).toHaveBeenCalledWith(searchUrl("acme/widgets", "author:octocat"), expect.anything());
    expect(errors).toEqual([]);
    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(prs[0].repo).toBe("acme/widgets");
  });
});
