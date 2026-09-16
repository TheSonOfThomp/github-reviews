import { faker } from "@faker-js/faker";
import type { FetchPullRequestsResult, PullRequest } from "./fetchPullRequests";

const DEMO_REPOS = ["acme/widgets", "acme/platform", "globex/rocket-ui"];
const DEMO_USERNAME = "demo-user";

// Seed lazily (not at module top level) so the module has no initialization
// side effects that could defeat tree-shaking in production builds
let seeded = false;
function ensureSeed() {
  if (!seeded) {
    faker.seed(42); // deterministic demo data across reloads
    seeded = true;
  }
}

// pravatar.cc serves a stable set of numbered placeholder photos (1..70)
const avatarUrl = () => `https://i.pravatar.cc/80?img=${faker.number.int({ min: 1, max: 70 })}`;

// Stable per-login avatar so the same fake user always gets the same face
const avatarByLogin = new Map<string, string>();
function avatarFor(login: string): string {
  if (!avatarByLogin.has(login)) avatarByLogin.set(login, avatarUrl());
  return avatarByLogin.get(login)!;
}

function fakeUsers(count = 3): Array<{ login: string; avatar_url: string }> {
  return Array.from({ length: count }, () => {
    const login = faker.internet.username();
    return { login, avatar_url: avatarFor(login) };
  });
}

function fakePRsForRepo(repo: string, count: number, authorLogin: string): PullRequest[] {
  return Array.from({ length: count }, () => {
    const number = faker.number.int({ min: 100, max: 9999 });
    return {
      id: faker.number.int({ min: 1_000_000, max: 9_999_999 }),
      number,
      title: faker.hacker.phrase(),
      html_url: `https://github.com/${repo}/pull/${number}`,
      user: { login: authorLogin, avatar_url: avatarFor(authorLogin) },
      created_at: faker.date.recent({ days: 14 }).toISOString(),
      updated_at: faker.date.recent({ days: 2 }).toISOString(),
      draft: faker.datatype.boolean({ probability: 0.25 }),
      requested_reviewers: fakeUsers(faker.number.int({ min: 1, max: 3 })).map((u) => ({ login: u.login })),
      repo,
    };
  });
}

// Small delay so the loading-spinner path is exercised in demo mode too
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function demoFetchAuthenticatedUser(): Promise<string> {
  ensureSeed();
  return DEMO_USERNAME;
}

export async function demoFetchOpenPullRequests(
  _githubToken: string,
  repos: string[],
  username: string
): Promise<FetchPullRequestsResult> {
  ensureSeed();
  await delay(200);
  const useRepos = repos.length ? repos : DEMO_REPOS;
  const user = username || DEMO_USERNAME;
  // Mirror the real filter: PRs whose requested_reviewers include the user
  const prs = useRepos.flatMap((repo) =>
    fakePRsForRepo(repo, faker.number.int({ min: 1, max: 6 }), faker.internet.username()).map((pr) => ({
      ...pr,
      requested_reviewers: [...pr.requested_reviewers, { login: user }],
    }))
  );
  return { prs, errors: [] };
}

export async function demoFetchMyOpenPullRequests(
  _githubToken: string,
  repos: string[],
  _username: string
): Promise<FetchPullRequestsResult> {
  ensureSeed();
  await delay(200);
  const useRepos = repos.length ? repos : DEMO_REPOS;
  const prs = useRepos.flatMap((repo) => fakePRsForRepo(repo, faker.number.int({ min: 0, max: 4 }), DEMO_USERNAME));
  return { prs, errors: [] };
}
