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

// Demo PR ages cycle through fixed values (not faker, so the faker sequence
// is untouched): the first PR of every batch is past the default 72h SLA and
// the rest are under it, so wait times always show both states (#26/#37).
const DEMO_PR_AGE_HOURS = [120, 3, 30, 8, 48, 20];
let demoPrAgeIndex = 0;

// pravatar.cc serves a stable set of numbered placeholder photos (1..70).
// Hashed from the login rather than drawn from faker, so the same user always
// gets the same face and avatars never shift the faker sequence (which made
// a seed's output depend on which logins earlier calls had seen).
function avatarFor(login: string): string {
  let hash = 0;
  for (const ch of login) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `https://i.pravatar.cc/80?img=${(hash % 70) + 1}`;
}

function fakeUsers(count = 3): Array<{ login: string; avatar_url: string }> {
  return Array.from({ length: count }, () => {
    const login = faker.internet.username();
    return { login, avatar_url: avatarFor(login) };
  });
}

// Demo PRs carry their requested reviewers and teams so the demo "search" can
// filter on them the way GitHub does server-side; the fields are stripped on
// output. Teams list their members, standing in for GitHub's team membership.
type DemoPull = PullRequest & {
  requested_reviewers: Array<{ login: string }>;
  requested_teams: Array<{ slug: string; members: string[] }>;
};

function fakePRsForRepo(repo: string, count: number, authorLogin: string): DemoPull[] {
  return Array.from({ length: count }, () => {
    const number = faker.number.int({ min: 100, max: 9999 });
    const created = new Date(
      (faker.defaultRefDate?.() ?? new Date()).getTime() -
        DEMO_PR_AGE_HOURS[demoPrAgeIndex++ % DEMO_PR_AGE_HOURS.length] * 3_600_000
    );
    return {
      id: faker.number.int({ min: 1_000_000, max: 9_999_999 }),
      number,
      title: faker.hacker.phrase(),
      html_url: `https://github.com/${repo}/pull/${number}`,
      user: { login: authorLogin, avatar_url: avatarFor(authorLogin) },
      created_at: created.toISOString(),
      updated_at: created.toISOString(),
      draft: faker.datatype.boolean({ probability: 0.25 }),
      requested_reviewers: fakeUsers(faker.number.int({ min: 1, max: 3 })).map((u) => ({ login: u.login })),
      requested_teams: [],
      repo,
    };
  });
}

// Small delay so the loading-spinner path is exercised in demo mode too
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * All open demo PRs for one repo: PRs requesting the reviewer's review,
 * PRs authored by the demo user, unrelated PRs that every search drops, and
 * PRs requesting review only from a team the reviewer is on (#27).
 */
function demoAllPullsForRepo(repo: string, reviewerLogin: string): DemoPull[] {
  // No ensureSeed() here: callers own the seed (the DEMO fetchers call it;
  // the E2E stub seeds per repo), and a first-call reseed would override theirs.
  // Reset the age cycle too so every generated batch assigns ages in the same
  // order and the same PR set keeps the same wait times across fetches.
  demoPrAgeIndex = 0;
  const pulls: DemoPull[] = [];

  const reviewCount = faker.number.int({ min: 1, max: 5 });
  for (let i = 0; i < reviewCount; i++) {
    const [pr] = fakePRsForRepo(repo, 1, faker.internet.username());
    pulls.push({ ...pr, requested_reviewers: [...pr.requested_reviewers, { login: reviewerLogin }] });
  }

  const mineCount = faker.number.int({ min: 1, max: 3 });
  pulls.push(...fakePRsForRepo(repo, mineCount, DEMO_USERNAME));

  const noiseCount = faker.number.int({ min: 0, max: 2 });
  pulls.push(...fakePRsForRepo(repo, noiseCount, faker.internet.username()));

  // Generated last so the faker sequence for the PRs above is unchanged
  const teamCount = faker.number.int({ min: 1, max: 3 });
  for (let i = 0; i < teamCount; i++) {
    const [pr] = fakePRsForRepo(repo, 1, faker.internet.username());
    pulls.push({ ...pr, requested_teams: [{ slug: "demo-team", members: [reviewerLogin] }] });
  }

  return pulls;
}

export type DemoSearchQualifier = "review-requested" | "user-review-requested" | "author";

/*
 * Search-API-style result items for one repo — shared by the DEMO-mode
 * fetchers and the E2E GitHub stub (e2e/stub/server.ts) so both serve the
 * same data, filtered the way GitHub's `review-requested:` (direct or team),
 * `user-review-requested:` (direct only) and `author:` qualifiers would.
 */
export function demoSearchPullsForRepo(
  repo: string,
  qualifier: DemoSearchQualifier,
  login: string
): PullRequest[] {
  return demoAllPullsForRepo(repo, login)
    .filter((pr) => {
      if (qualifier === "author") return pr.user.login === login;
      const direct = pr.requested_reviewers.some((r) => r.login === login);
      if (qualifier === "user-review-requested") return direct;
      return direct || pr.requested_teams.some((t) => t.members.includes(login));
    })
    .map(({ requested_reviewers: _r, requested_teams: _t, ...pr }) => pr);
}

export async function demoFetchAuthenticatedUser(): Promise<string> {
  ensureSeed();
  return DEMO_USERNAME;
}

export async function demoFetchOpenPullRequests(
  _githubToken: string,
  repos: string[],
  username: string,
  includeTeamRequests: boolean
): Promise<FetchPullRequestsResult> {
  ensureSeed();
  await delay(200);
  const useRepos = repos.length ? repos : getDemoRepos();
  const user = username || DEMO_USERNAME;
  const qualifier = includeTeamRequests ? "review-requested" : "user-review-requested";
  const prs = useRepos.flatMap((repo) => demoSearchPullsForRepo(repo, qualifier, user));
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
  const prs = useRepos.flatMap((repo) => demoSearchPullsForRepo(repo, "author", DEMO_USERNAME));
  return { prs, errors: [] };
}
