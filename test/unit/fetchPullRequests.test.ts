import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchAuthenticatedUser,
  fetchPrEnrichments,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
  rollupStateToCIStatus,
  searchUrl,
  timelineEnrichments,
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

    const result = await fetchOpenPullRequests("", ["acme/widgets"], "octocat", true);

    expect(result).toEqual({ prs: [], errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[BACKGROUND] no GitHub token set");
    warn.mockRestore();
  });

  it("returns empty results without fetching when no repos are configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchOpenPullRequests("token", [], "octocat", true);

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

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    expect(fetchMock).toHaveBeenCalledWith(
      searchUrl("acme/widgets", "review-requested:octocat"),
      expect.anything()
    );
    expect(errors).toEqual([]);
    expect(prs.map((p) => p.number)).toEqual([1, 3]);
    expect(prs.every((p) => p.repo === "acme/widgets")).toBe(true);
  });

  it("searches for direct requests only when team requests are excluded", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({ body: searchBody([pr(2)]) }));

    const { prs } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", false);

    expect(fetchMock).toHaveBeenCalledWith(
      searchUrl("acme/widgets", "user-review-requested:octocat"),
      expect.anything()
    );
    expect(prs.map((p) => p.number)).toEqual([2]);
  });

  it("returns empty results without fetching when no username is resolved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchOpenPullRequests("token", ["acme/widgets"], "", true);

    expect(result).toEqual({ prs: [], errors: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns when more results match than one page returns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(makeResponse({ body: searchBody([pr(1)], 250) }));

    const { prs } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    expect(prs).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("showing 1 of 250"));
    warn.mockRestore();
  });

  it("reports a plain API error for a failing repo without SSO header", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 500, statusText: "Internal Server Error" })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/broken"], "octocat", true);

    expect(prs).toEqual([]);
    expect(errors).toEqual([
      { repo: "acme/broken", message: "GitHub API error for acme/broken: 500 Internal Server Error" },
    ]);
  });

  it("reports a missing or inaccessible repo (422) as an access error", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 422, statusText: "Unprocessable Entity" })
    );

    const { errors } = await fetchOpenPullRequests("token", ["acme/missing"], "octocat", true);

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

    const { errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

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

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/private"], "octocat", true);

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

    const { errors } = await fetchOpenPullRequests("token", ["acme/private"], "octocat", true);

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
      "octocat",
      true
    );

    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(errors).toEqual([
      { repo: "acme/failing", message: "Failed to fetch acme/failing: network down" },
    ]);
    error.mockRestore();
  });
});

/** GraphQL response body mapping node IDs to statusCheckRollup states (+ optional timeline events). */
const graphqlBody = (states: Record<string, string | null>, timelines: Record<string, object[]> = {}) => ({
  data: {
    nodes: Object.entries(states).map(([id, state]) => ({
      id,
      commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
      ...(timelines[id] ? { timelineItems: { nodes: timelines[id] } } : {}),
    })),
  },
});

describe("rollupStateToCIStatus", () => {
  it("maps combined rollup states onto icon states", () => {
    expect(rollupStateToCIStatus("SUCCESS")).toBe("success");
    expect(rollupStateToCIStatus("FAILURE")).toBe("failure");
    expect(rollupStateToCIStatus("ERROR")).toBe("failure");
    expect(rollupStateToCIStatus("PENDING")).toBe("pending");
    expect(rollupStateToCIStatus("EXPECTED")).toBe("pending");
    expect(rollupStateToCIStatus(null)).toBeUndefined();
    expect(rollupStateToCIStatus(undefined)).toBeUndefined();
  });
});

describe("timelineEnrichments", () => {
  const at = "2026-01-02T00:00:00Z";

  it("matches the latest event where the user was directly requested", () => {
    const node = {
      timelineItems: {
        nodes: [
          { createdAt: "2026-01-01T00:00:00Z", requestedReviewer: { login: "octocat" } },
          { createdAt: "2026-01-03T00:00:00Z", requestedReviewer: { login: "octocat" } },
          { createdAt: "2026-01-04T00:00:00Z", requestedReviewer: { login: "someone-else" } },
        ],
      },
    };
    expect(timelineEnrichments(node, "octocat", true)).toEqual({
      review_requested_at: "2026-01-03T00:00:00Z",
      ready_for_review_at: undefined,
    });
  });

  it("counts team events only when team requests are included", () => {
    const node = {
      timelineItems: { nodes: [{ createdAt: at, requestedReviewer: { slug: "core" } }] },
    };
    expect(timelineEnrichments(node, "octocat", true).review_requested_at).toBe(at);
    expect(timelineEnrichments(node, "octocat", false).review_requested_at).toBeUndefined();
  });

  it("takes the latest ready-for-review time, dropped while the PR is back in draft", () => {
    const ready = {
      timelineItems: {
        nodes: [{ createdAt: "2026-01-01T00:00:00Z" }, { createdAt: "2026-01-05T00:00:00Z" }],
      },
    };
    expect(timelineEnrichments(ready, "octocat", true).ready_for_review_at).toBe("2026-01-05T00:00:00Z");
    expect(timelineEnrichments({ ...ready, isDraft: true }, "octocat", true).ready_for_review_at).toBeUndefined();
  });
});

describe("fetchPrEnrichments", () => {
  it("batches all PRs into one GraphQL nodes(ids:) query and maps states", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: graphqlBody({ n1: "SUCCESS", n2: "FAILURE", n3: "PENDING", n4: null }) })
    );

    const enrichments = await fetchPrEnrichments(
      "token",
      [pr(1, { node_id: "n1" }), pr(2, { node_id: "n2" }), pr(3, { node_id: "n3" }), pr(4, { node_id: "n4" })],
      "octocat",
      true
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).variables.ids).toEqual(["n1", "n2", "n3", "n4"]);
    expect(enrichments.get("n1")).toEqual({ ci_status: "success", review_requested_at: undefined, ready_for_review_at: undefined });
    expect(enrichments.get("n2")).toEqual({ ci_status: "failure", review_requested_at: undefined, ready_for_review_at: undefined });
    expect(enrichments.get("n4")).toEqual({ review_requested_at: undefined, ready_for_review_at: undefined });
  });

  it("resolves review-request and ready times from the timeline events", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: graphqlBody(
          { n1: "SUCCESS" },
          {
            n1: [
              { createdAt: "2026-01-02T00:00:00Z", requestedReviewer: { login: "octocat" } },
              { createdAt: "2026-01-01T00:00:00Z" },
            ],
          }
        ),
      })
    );

    const enrichments = await fetchPrEnrichments("token", [pr(1, { node_id: "n1" })], "octocat", true);

    expect(enrichments.get("n1")).toEqual({
      ci_status: "success",
      review_requested_at: "2026-01-02T00:00:00Z",
      ready_for_review_at: "2026-01-01T00:00:00Z",
    });
  });

  it("chunks IDs into batches of 100", async () => {
    const prs = Array.from({ length: 150 }, (_, i) => pr(i, { node_id: `n${i}` }));
    fetchMock.mockImplementation(async () => makeResponse({ body: graphqlBody({}) }));

    await fetchPrEnrichments("token", prs, "octocat", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstIds = JSON.parse(fetchMock.mock.calls[0][1].body).variables.ids;
    const secondIds = JSON.parse(fetchMock.mock.calls[1][1].body).variables.ids;
    expect(firstIds).toHaveLength(100);
    expect(secondIds).toHaveLength(50);
  });

  it("skips the request entirely when no PR carries a node_id", async () => {
    const enrichments = await fetchPrEnrichments("token", [pr(1), pr(2)], "octocat", true);
    expect(enrichments.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("CI status enrichment in fetchOpenPullRequests", () => {
  const items = [pr(1, { node_id: "n1" }), pr(2, { node_id: "n2" })];

  it("attaches ci_status to the search results", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("https://api.github.com/search")
        ? makeResponse({ body: searchBody(items) })
        : makeResponse({ body: graphqlBody({ n1: "SUCCESS", n2: "ERROR" }) })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    expect(errors).toEqual([]);
    expect(prs.map((p) => p.ci_status)).toEqual(["success", "failure"]);
  });

  it("attaches review-request and ready times from the team-inclusive review search", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("https://api.github.com/search")
        ? makeResponse({ body: searchBody(items) })
        : makeResponse({
            body: graphqlBody(
              { n1: "SUCCESS", n2: null },
              {
                n1: [
                  { createdAt: "2026-01-02T00:00:00Z", requestedReviewer: { slug: "core" } },
                  { createdAt: "2026-01-01T00:00:00Z" },
                ],
              }
            ),
          })
    );

    const { prs } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    // A team event matched because this search includes team requests
    expect(prs[0].review_requested_at).toBe("2026-01-02T00:00:00Z");
    expect(prs[0].ready_for_review_at).toBe("2026-01-01T00:00:00Z");
  });

  it("ignores team events in the author view — own PRs keep PR age", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("https://api.github.com/search")
        ? makeResponse({ body: searchBody([pr(1, { user: { login: "octocat", avatar_url: "" }, node_id: "n1" })]) })
        : makeResponse({
            body: graphqlBody(
              { n1: "SUCCESS" },
              { n1: [{ createdAt: "2026-01-02T00:00:00Z", requestedReviewer: { slug: "core" } }] }
            ),
          })
    );

    const { prs } = await fetchMyOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(prs[0].review_requested_at).toBeUndefined();
  });

  it("leaves the PR list intact when the GraphQL request is rate-limited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("https://api.github.com/search")
        ? makeResponse({ body: searchBody(items) })
        : makeResponse({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            headers: { "x-ratelimit-remaining": "0" },
          })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    expect(errors).toEqual([]);
    expect(prs).toHaveLength(2);
    expect(prs.every((p) => p.ci_status === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[BACKGROUND] PR enrichment lookup failed; rendering PRs without CI icons or request times:",
      expect.objectContaining({ message: "GitHub GraphQL rate limit hit" })
    );
    warn.mockRestore();
  });

  it("leaves the PR list intact when GraphQL returns query errors (e.g. missing scopes)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("https://api.github.com/search")
        ? makeResponse({ body: searchBody(items) })
        : makeResponse({ body: { errors: [{ message: "Field 'statusCheckRollup' requires scope" }] } })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    expect(errors).toEqual([]);
    expect(prs).toHaveLength(2);
    expect(prs.every((p) => p.ci_status === undefined)).toBe(true);
    warn.mockRestore();
  });

  it("leaves the PR list intact when the GraphQL fetch rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://api.github.com/search")) {
        return makeResponse({ body: searchBody(items) });
      }
      throw new Error("network down");
    });

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat", true);

    expect(errors).toEqual([]);
    expect(prs).toHaveLength(2);
    warn.mockRestore();
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
