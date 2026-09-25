import {
  demoFetchAuthenticatedUser,
  demoFetchMyOpenPullRequests,
  demoFetchOpenPullRequests,
} from "./demoData";

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  draft: boolean;
  repo: string;
}

export interface RepoError {
  repo: string;
  message: string;
  ssoAuthorizeUrl?: string;
}

export interface FetchPullRequestsResult {
  prs: PullRequest[];
  errors: RepoError[];
}

const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});

export async function fetchAuthenticatedUser(githubToken: string): Promise<string> {
  if (process.env.DEMO_MODE === "true") return demoFetchAuthenticatedUser();
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(githubToken),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch authenticated user: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.login as string;
}

/*
 * Search-API query per repo. GitHub filters server-side, so large repos
 * (e.g. 10gen/mms, 1500+ open PRs) no longer lose matches past the first
 * page of /pulls (#10). `review-requested:` also matches team requests.
 */
export const searchUrl = (repo: string, qualifier: string) =>
  `https://api.github.com/search/issues?q=${encodeURIComponent(
    `repo:${repo} is:pr is:open ${qualifier}`
  )}&per_page=100`;

function errorForResponse(repo: string, response: Response): RepoError {
  // Detect SSO enforcement — GitHub returns a URL to authorize the token
  const ssoHeader = response.headers.get("X-GitHub-SSO");
  const ssoAuthorizeUrl = ssoHeader?.match(/url=([^;]+)/)?.[1];
  if (ssoAuthorizeUrl) {
    return { repo, message: `SSO authorization required for ${repo}`, ssoAuthorizeUrl };
  }
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const seconds = reset ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : undefined;
    return {
      repo,
      message: `GitHub search rate limit hit${seconds !== undefined ? ` — retry in ${seconds}s` : ""}`,
    };
  }
  if (response.status === 422) {
    return { repo, message: `Repo ${repo} not found, or your token lacks access to it` };
  }
  return { repo, message: `GitHub API error for ${repo}: ${response.status} ${response.statusText}` };
}

async function fetchPRsFromRepos(
  githubToken: string,
  repos: string[],
  username: string,
  qualifierKey: "review-requested" | "author",
  logLabel: string
): Promise<FetchPullRequestsResult> {
  if (!githubToken) {
    console.warn("[BACKGROUND] no GitHub token set");
    return { prs: [], errors: [] };
  }
  if (!repos.length) {
    console.warn("[BACKGROUND] no repos configured");
    return { prs: [], errors: [] };
  }
  if (!username) {
    console.warn("[BACKGROUND] no GitHub username resolved");
    return { prs: [], errors: [] };
  }
  const qualifier = `${qualifierKey}:${username}`;

  const results = await Promise.allSettled(
    repos.map(async (repo): Promise<{ prs: PullRequest[]; error?: RepoError }> => {
      console.log(`[BACKGROUND] searching ${logLabel} in ${repo} (${qualifier})`);
      const response = await fetch(searchUrl(repo, qualifier), {
        headers: githubHeaders(githubToken),
      });

      if (!response.ok) return { prs: [], error: errorForResponse(repo, response) };

      // Search silently drops SSO-protected results the token isn't
      // authorized for, flagging it with a "partial-results" header
      if (response.headers.get("X-GitHub-SSO")?.startsWith("partial-results")) {
        return {
          prs: [],
          error: {
            repo,
            message: `SSO authorization required for ${repo}`,
            ssoAuthorizeUrl: "https://github.com/settings/tokens",
          },
        };
      }

      const data: { total_count: number; items: PullRequest[] } = await response.json();
      if (data.total_count > data.items.length) {
        console.warn(`[BACKGROUND] ${repo}: showing ${data.items.length} of ${data.total_count} ${logLabel}`);
      }
      return { prs: data.items.map((pr) => ({ ...pr, repo })) };
    })
  );

  const prs: PullRequest[] = [];
  const errors: RepoError[] = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      prs.push(...result.value.prs);
      if (result.value.error) errors.push(result.value.error);
    } else {
      // Surface rejected fetches (network error, bad JSON) instead of
      // letting the repo render as an empty "no PRs" list
      console.error(result.reason);
      const repo = repos[i];
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ repo, message: `Failed to fetch ${repo}: ${reason}` });
    }
  });

  console.log(
    `[BACKGROUND] ${prs.length} ${logLabel} across ${repos.length} repo(s), ${errors.length} error(s)`
  );
  return { prs, errors };
}

export async function fetchOpenPullRequests(
  githubToken: string,
  repos: string[],
  username: string
): Promise<FetchPullRequestsResult> {
  if (process.env.DEMO_MODE === "true") return demoFetchOpenPullRequests(githubToken, repos, username);
  return fetchPRsFromRepos(
    githubToken,
    repos,
    username,
    "review-requested",
    "PRs awaiting review"
  );
}

export async function fetchMyOpenPullRequests(
  githubToken: string,
  repos: string[],
  username: string
): Promise<FetchPullRequestsResult> {
  if (process.env.DEMO_MODE === "true") return demoFetchMyOpenPullRequests(githubToken, repos, username);
  return fetchPRsFromRepos(
    githubToken,
    repos,
    username,
    "author",
    "my open PRs"
  );
}
