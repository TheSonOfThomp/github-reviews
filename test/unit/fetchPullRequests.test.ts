import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
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
  requested_reviewers: [],
  repo: "",
  ...overrides,
});

const pullsUrl = (repo: string) =>
  `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`;

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

describe("fetchOpenPullRequests", () => {
  it("returns only PRs requesting a review from the user, tagged with the repo", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: [
          pr(1, { requested_reviewers: [{ login: "octocat" }] }),
          pr(2, { requested_reviewers: [{ login: "other-user" }] }),
          pr(3, { requested_reviewers: [{ login: "octocat" }, { login: "another" }] }),
        ],
      })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(errors).toEqual([]);
    expect(prs.map((p) => p.number)).toEqual([1, 3]);
    expect(prs.every((p) => p.repo === "acme/widgets")).toBe(true);
  });

  it("reports a plain API error for a failing repo without SSO header", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ ok: false, status: 404, statusText: "Not Found" })
    );

    const { prs, errors } = await fetchOpenPullRequests("token", ["acme/missing"], "octocat");

    expect(prs).toEqual([]);
    expect(errors).toEqual([
      { repo: "acme/missing", message: "GitHub API error for acme/missing: 404 Not Found" },
    ]);
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

  it("merges results across repos and keeps a failing repo from breaking the others", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === pullsUrl("acme/ok")) {
        return makeResponse({ body: [pr(1, { requested_reviewers: [{ login: "octocat" }] })] });
      }
      if (url === pullsUrl("acme/failing")) {
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
    // A rejected fetch is logged, not surfaced as a RepoError
    expect(errors).toEqual([]);
    expect(error).toHaveBeenCalledWith(new Error("network down"));
    error.mockRestore();
  });
});

describe("fetchMyOpenPullRequests", () => {
  it("returns only PRs authored by the user", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({
        body: [
          pr(1, { user: { login: "octocat", avatar_url: "" } }),
          pr(2, { user: { login: "someone-else", avatar_url: "" } }),
        ],
      })
    );

    const { prs, errors } = await fetchMyOpenPullRequests("token", ["acme/widgets"], "octocat");

    expect(errors).toEqual([]);
    expect(prs.map((p) => p.number)).toEqual([1]);
    expect(prs[0].repo).toBe("acme/widgets");
  });
});
