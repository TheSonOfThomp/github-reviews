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

export async function fetchOpenPullRequests(
  githubToken: string,
  repos: string[],
  username: string
): Promise<PullRequest[]> {
  if (!githubToken) {
    console.warn("[BACKGROUND] no GitHub token set");
    return [];
  }
  if (!repos.length) {
    console.warn("[BACKGROUND] no repos configured");
    return [];
  }

  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`;
      console.log(`[BACKGROUND] fetching PRs from ${repo} for user ${username}`, url);
      const response = await fetch(url, {
        headers: githubHeaders(githubToken),
      });

      if (!response.ok) {
        throw new Error(
          `[BACKGROUND] GitHub API error for ${repo}: ${response.status} ${response.statusText}`
        );
      }

      const prs: PullRequest[] = await response.json();
      return prs
        .map((pr) => ({ ...pr, repo }))
        .filter((pr) =>
          pr.requested_reviewers.some((r) => r.login === username)
        );
    })
  );

  const pullRequests: PullRequest[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      pullRequests.push(...result.value);
    } else {
      console.error(result.reason);
    }
  }

  console.log(
    `[BACKGROUND] ${pullRequests.length} PR(s) awaiting review from ${username} across ${repos.length} repo(s)`
  );
  return pullRequests;
}
