import {
  demoFetchAuthenticatedUser,
  demoFetchMyOpenPullRequests,
  demoFetchOpenPullRequests,
} from "./demoData";

export type CIStatus = "success" | "failure" | "pending";

export interface PullRequest {
  id: number;
  // GraphQL node ID, present on Search API items; used to batch the CI
  // status lookup. Optional so older cache entries stay readable.
  node_id?: string;
  number: number;
  title: string;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  draft: boolean;
  repo: string;
  /** Latest review_requested event matching the user (or their team); undefined = none matched. */
  review_requested_at?: string;
  /** When the PR last left draft; undefined while it is (or was never) out of draft. */
  ready_for_review_at?: string;
  /** Combined check/status state of the head commit; undefined = no checks (or lookup failed). */
  ci_status?: CIStatus;
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
 * page of /pulls (#10). `review-requested:` also matches team requests;
 * `user-review-requested:` matches only direct, individual ones (#27).
 */
export const searchUrl = (repo: string, qualifier: string) =>
  `https://api.github.com/search/issues?q=${encodeURIComponent(
    `repo:${repo} is:pr is:open ${qualifier}`
  )}&per_page=100`;

const GRAPHQL_URL = "https://api.github.com/graphql";
// nodes(ids:) accepts at most 100 IDs per query
const GRAPHQL_IDS_PER_QUERY = 100;

const PR_ENRICHMENT_QUERY = `
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        id
        isDraft
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT], last: 100) {
          nodes {
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { ... on User { login } ... on Team { slug } }
            }
            ... on ReadyForReviewEvent { createdAt }
          }
        }
      }
    }
  }
`;

type StatusCheckRollupState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";

/** Maps the combined statusCheckRollup state onto the popover's icon states. */
export const rollupStateToCIStatus = (state: StatusCheckRollupState | null | undefined): CIStatus | undefined => {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default: // null — the commit has no checks configured
      return undefined;
  }
};

interface RequestedReviewer {
  login?: string;
  slug?: string;
}

interface TimelineEvent {
  createdAt?: string;
  requestedReviewer?: RequestedReviewer | null;
}

interface GraphQLNode {
  id?: string;
  isDraft?: boolean;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: StatusCheckRollupState } | null } }> };
  timelineItems?: { nodes?: TimelineEvent[] };
}

export interface PrEnrichment {
  ci_status?: CIStatus;
  review_requested_at?: string;
  ready_for_review_at?: string;
}

/** Latest matching review_requested event, and the latest ready-for-review time (#26). */
export const timelineEnrichments = (
  node: GraphQLNode,
  username: string,
  matchTeams: boolean
): Pick<PrEnrichment, "review_requested_at" | "ready_for_review_at"> => {
  let requestedAt: string | undefined;
  let readyAt: string | undefined;
  for (const event of node.timelineItems?.nodes ?? []) {
    if (!event.createdAt) continue;
    if (event.requestedReviewer) {
      // Team membership can't be verified here — but the search already
      // filtered to PRs requested of the user or their team, so a team
      // event on a matched PR counts when team requests are included
      const matches =
        event.requestedReviewer.login === username ||
        (matchTeams && event.requestedReviewer.slug !== undefined);
      if (matches && (!requestedAt || event.createdAt > requestedAt)) requestedAt = event.createdAt;
    } else {
      if (!readyAt || event.createdAt > readyAt) readyAt = event.createdAt;
    }
  }
  // A PR back in draft has no meaningful out-of-draft time
  if (node.isDraft) readyAt = undefined;
  return { review_requested_at: requestedAt, ready_for_review_at: readyAt };
};

/*
 * Batched PR enrichment (#32/#26). Search items are issue-shaped and carry
 * no check or timeline data, but they do carry `node_id`, so one GraphQL
 * nodes(ids:) query per 100 PRs resolves every head commit's CI status and
 * the review-request/ready-for-review timestamps — far cheaper than 2–3
 * REST calls per PR, and it uses the GraphQL rate-limit budget (separate
 * from search's 30 req/min). Returns node_id → enrichment.
 */
export async function fetchPrEnrichments(
  githubToken: string,
  prs: PullRequest[],
  username: string,
  matchTeams: boolean
): Promise<Map<string, PrEnrichment>> {
  const enrichments = new Map<string, PrEnrichment>();
  const ids = prs.map((pr) => pr.node_id).filter((id): id is string => Boolean(id));
  for (let i = 0; i < ids.length; i += GRAPHQL_IDS_PER_QUERY) {
    const chunk = ids.slice(i, i + GRAPHQL_IDS_PER_QUERY);
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { ...githubHeaders(githubToken), "Content-Type": "application/json" },
      body: JSON.stringify({ query: PR_ENRICHMENT_QUERY, variables: { ids: chunk } }),
    });

    if (!response.ok) {
      const rateLimited =
        (response.status === 403 || response.status === 429) &&
        response.headers.get("x-ratelimit-remaining") === "0";
      throw new Error(
        rateLimited
          ? "GitHub GraphQL rate limit hit"
          : `GitHub GraphQL error: ${response.status} ${response.statusText}`
      );
    }

    const data: { data?: { nodes?: GraphQLNode[] }; errors?: Array<{ message: string }> } =
      await response.json();
    // GraphQL returns 200 for query-level errors (e.g. missing token scopes)
    if (data.errors?.length || !data.data?.nodes) {
      throw new Error(`GitHub GraphQL error: ${data.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
    }

    for (const node of data.data.nodes) {
      if (!node?.id) continue;
      const enrichment: PrEnrichment = { ...timelineEnrichments(node, username, matchTeams) };
      const status = rollupStateToCIStatus(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state);
      if (status) enrichment.ci_status = status;
      enrichments.set(node.id, enrichment);
    }
  }
  return enrichments;
}

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
  qualifierKey: "review-requested" | "user-review-requested" | "author",
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

  // Attach CI statuses and review-request timestamps from the batched GraphQL
  // lookup. A failed lookup (network, rate limit, token missing scopes) must
  // not fail the refresh — render the PRs without them instead (#32/#26).
  // Team timeline events only count in the team-inclusive review search; the
  // author view's own PRs would otherwise inherit their reviewers' requests.
  try {
    const enrichments = await fetchPrEnrichments(
      githubToken,
      prs,
      username,
      qualifierKey === "review-requested"
    );
    for (const pr of prs) {
      const enrichment = pr.node_id ? enrichments.get(pr.node_id) : undefined;
      if (enrichment) Object.assign(pr, enrichment);
    }
  } catch (e) {
    console.warn("[BACKGROUND] PR enrichment lookup failed; rendering PRs without CI icons or request times:", e);
  }

  console.log(
    `[BACKGROUND] ${prs.length} ${logLabel} across ${repos.length} repo(s), ${errors.length} error(s)`
  );
  return { prs, errors };
}

export async function fetchOpenPullRequests(
  githubToken: string,
  repos: string[],
  username: string,
  includeTeamRequests: boolean
): Promise<FetchPullRequestsResult> {
  if (process.env.DEMO_MODE === "true")
    return demoFetchOpenPullRequests(githubToken, repos, username, includeTeamRequests);
  return fetchPRsFromRepos(
    githubToken,
    repos,
    username,
    includeTeamRequests ? "review-requested" : "user-review-requested",
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
