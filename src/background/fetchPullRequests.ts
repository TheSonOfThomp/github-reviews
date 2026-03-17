export interface PullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  draft: boolean;
  requested_reviewers: Array<{ login: string }>;
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
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(githubToken),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch authenticated user: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.login as string;
}

async function fetchPRsFromRepos(
  githubToken: string,
  repos: string[],
  username: string,
  filter: (pr: PullRequest, username: string) => boolean,
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

  const results = await Promise.allSettled(
    repos.map(async (repo): Promise<{ prs: PullRequest[]; error?: RepoError }> => {
      const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`;
      console.log(`[BACKGROUND] fetching ${logLabel} from ${repo} for user ${username}`);
      const response = await fetch(url, {
        headers: githubHeaders(githubToken),
      });

      if (!response.ok) {
        // Detect SSO enforcement — GitHub returns a URL to authorize the token
        const ssoHeader = response.headers.get("X-GitHub-SSO");
        const ssoMatch = ssoHeader?.match(/url=([^;]+)/);
        const ssoAuthorizeUrl = ssoMatch?.[1];

        const error: RepoError = {
          repo,
          message: ssoAuthorizeUrl
            ? `SSO authorization required for ${repo}`
            : `GitHub API error for ${repo}: ${response.status} ${response.statusText}`,
          ...(ssoAuthorizeUrl ? { ssoAuthorizeUrl } : {}),
        };
        return { prs: [], error };
      }

      const prs: PullRequest[] = await response.json();
      return {
        prs: prs.map((pr) => ({ ...pr, repo })).filter((pr) => filter(pr, username)),
      };
    })
  );

  const prs: PullRequest[] = [];
  const errors: RepoError[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      prs.push(...result.value.prs);
      if (result.value.error) errors.push(result.value.error);
    } else {
      console.error(result.reason);
    }
  }

  console.log(
    `[BACKGROUND] ${prs.length} ${logLabel} for ${username} across ${repos.length} repo(s), ${errors.length} error(s)`
  );
  return { prs, errors };
}

export async function fetchOpenPullRequests(
  githubToken: string,
  repos: string[],
  username: string
): Promise<FetchPullRequestsResult> {
  return fetchPRsFromRepos(
    githubToken,
    repos,
    username,
    (pr, user) => pr.requested_reviewers.some((r) => r.login === user),
    "PRs awaiting review"
  );
}

export async function fetchMyOpenPullRequests(
  githubToken: string,
  repos: string[],
  username: string
): Promise<FetchPullRequestsResult> {
  return fetchPRsFromRepos(
    githubToken,
    repos,
    username,
    (pr, user) => pr.user.login === user,
    "my open PRs"
  );
}
