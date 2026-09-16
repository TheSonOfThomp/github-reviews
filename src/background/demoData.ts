import { faker } from "@faker-js/faker";
import type { FetchPullRequestsResult, PullRequest } from "./fetchPullRequests";

// Seed lazily (not at module top level) so the module has no initialization
// side effects that could defeat tree-shaking in production builds
let seeded = false;
function ensureSeed() {
  if (!seeded) {
    faker.seed(42); // deterministic demo data across reloads
    seeded = true;
  }
}

// Fake repositories, generated once per session (seeded) so they are
// deterministic and both view modes group under the same repo set.
// Slugified because some faker words contain spaces (e.g. "solid state")
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
let demoRepos: string[] | null = null;
function getDemoRepos(): string[] {
  if (!demoRepos) {
    ensureSeed();
    const count = faker.number.int({ min: 3, max: 5 });
    demoRepos = Array.from({ length: count }, () =>
      `${slug(faker.internet.domainWord())}/${slug(faker.hacker.adjective())}-${slug(faker.hacker.noun())}`
    );
  }
  return demoRepos;
}

export const DEMO_USERNAME = "demo-user";

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

/*
 * Raw /pulls-style response body for one repo — shared by the DEMO-mode
 * fetchers and the E2E GitHub stub (e2e/stub/server.ts) so both serve the
 * same data. Includes all three PR kinds the real API would return:
 * PRs requesting the reviewer's review, PRs authored by the demo user,
 * and unrelated PRs that both view filters drop.
 */
export function demoRawPullsForRepo(repo: string, reviewerLogin: string): PullRequest[] {
  ensureSeed();
  const pulls: PullRequest[] = [];

  const reviewCount = faker.number.int({ min: 1, max: 5 });
  for (let i = 0; i < reviewCount; i++) {
    const [pr] = fakePRsForRepo(repo, 1, faker.internet.username());
    pulls.push({ ...pr, requested_reviewers: [...pr.requested_reviewers, { login: reviewerLogin }] });
  }

  const mineCount = faker.number.int({ min: 1, max: 3 });
  pulls.push(...fakePRsForRepo(repo, mineCount, DEMO_USERNAME));

  const noiseCount = faker.number.int({ min: 0, max: 2 });
  pulls.push(...fakePRsForRepo(repo, noiseCount, faker.internet.username()));

  return pulls;
}

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
  const useRepos = repos.length ? repos : getDemoRepos();
  const user = username || DEMO_USERNAME;
  // Mirror the real filter: PRs whose requested_reviewers include the user
  const prs = useRepos
    .flatMap((repo) => demoRawPullsForRepo(repo, user))
    .filter((pr) => pr.requested_reviewers.some((r) => r.login === user));
  return { prs, errors: [] };
}

export async function demoFetchMyOpenPullRequests(
  _githubToken: string,
  repos: string[],
  _username: string
): Promise<FetchPullRequestsResult> {
  ensureSeed();
  await delay(200);
  const useRepos = repos.length ? repos : getDemoRepos();
  const prs = useRepos
    .flatMap((repo) => demoRawPullsForRepo(repo, DEMO_USERNAME))
    .filter((pr) => pr.user.login === DEMO_USERNAME);
  return { prs, errors: [] };
}
