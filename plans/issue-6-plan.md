# Implementation Plan — Issue #6: Add DEMO mode flag

## 1. Issue summary (in my own words)

Add a `DEMO` mode to the extension. When the app is built/run with this flag enabled, it should serve locally generated fake data (via Faker.js) — including fake user avatars from a placeholder image provider — instead of making any requests to the real GitHub API. This is useful for demos, screenshots, development without a token, and UI work without burning API quota.

## 2. Current behavior (with references)

- **All GitHub API access is centralized in `src/background/fetchPullRequests.ts`:**
  - `githubHeaders()` (lines 30–34) builds auth headers used by every request.
  - `fetchAuthenticatedUser(githubToken)` (lines 36–45) — `GET https://api.github.com/user`, returns `login`. Called from `background.ts` at startup (line 40) and on token change (line 57).
  - `fetchPRsFromRepos(...)` (lines 47–104) — private helper doing the actual `fetch` per repo, parsing SSO headers, filtering results. Used by the two public fetchers:
    - `fetchOpenPullRequests` (lines 107–117) — PRs where `requested_reviewers` includes the user.
    - `fetchMyOpenPullRequests` (lines 119–129) — PRs authored by the user.
  - Returns `FetchPullRequestsResult { prs: PullRequest[]; errors: RepoError[] }`; `PullRequest` shape defined at lines 1–13 (`id, number, title, html_url, user: {login, avatar_url}, created_at, updated_at, draft, requested_reviewers, repo`).
- **`src/background/background.ts`:**
  - `refreshPullRequests()` (lines 22–31) bails out early (badge = 0) if no token/repos/username — lines 23–27.
  - Message handlers `GET_PULL_REQUESTS` / `GET_MY_PULL_REQUESTS` (lines 76–93) call the fetchers and `sendResponse`.
  - Startup reads `githubToken`/`repos` from `chrome.storage.sync` (lines 33–44).
- **`src/popover/popover.tsx`:**
  - Data-loading `useEffect` (lines 55–79): reads token/repos from storage and sets `no-token` / `no-repos` state (lines 60–68) *before* ever messaging the background — so even if the background served fake data, the popover would still block on a missing token.
  - `avatar_url` is consumed as an `<img src>` in the PR row (lines ~166–173) — image tags need no `host_permissions`.
- **Build: `rollup.config.mjs`** already uses `@rollup/plugin-replace` (lines 11–15) to substitute `process.env.NODE_ENV` → `"production"`. The same mechanism can statically inject a `process.env.DEMO_MODE` literal into every bundle (popover, content, background, options share one `plugins` array).
- **Manifest (`build/manifest.json`):** `host_permissions: ["https://api.github.com/*"]`; options page stores token/repos in `chrome.storage.sync`.

**Key constraint:** there is exactly one data seam (the fetchers in `fetchPullRequests.ts` plus the token/repo guards in `background.ts` and `popover.tsx`). DEMO mode needs to intercept all three guards/fetches or the popover will still show `no-token`.

## 3. Proposed design

**Build-time flag via rollup `replace` + a dedicated demo data module, intercepted at the fetch layer.**

- `rollup.config.mjs` gains a `DEMO_MODE` entry in the existing `replace({...})` plugin, sourced from `process.env.DEMO_MODE` at build time (`'1'`/`'true'` → `"true"`, else `"false"`). Because `replace` substitutes a string literal before bundling, `if (process.env.DEMO_MODE)` becomes `if ("false")` in normal builds — dead-code-eliminated — and `if ("true")` in demo builds.
- New module `src/background/demoData.ts` exports demo implementations matching the existing public API: `fetchAuthenticatedUser`, `fetchOpenPullRequests`, `fetchMyOpenPullRequests` (same signatures, same `PullRequest`/`RepoError`/`FetchPullRequestsResult` types — they're exported from `fetchPullRequests.ts`, so reuse them).
- `src/background/fetchPullRequests.ts` branches at the top of each exported function: if `process.env.DEMO_MODE === "true"`, delegate to the demo generator. This keeps **both** the badge refresh path and the popover message path on demo data with a single interception point.
- `src/background/background.ts`: in DEMO mode, `refreshPullRequests()` skips the token/repos/username guard (still updates badge from demo data), and startup skips the real `fetchAuthenticatedUser` (the demo one returns a fake login).
- `src/popover/popover.tsx`: in DEMO mode, skip the `no-token`/`no-repos` early returns so the message flow runs and renders demo PRs.
- **Avatars:** use `pravatar.cc` (`https://i.pravatar.cc/80?img=<1..70>`) — photorealistic placeholder faces, deterministic per fake user via `faker.number.int({min:1, max:70})`. It's consumed as `<img src>` so no manifest/host-permission changes are needed. Alternatives considered below.
- **Dependency:** `@faker-js/faker` (add as a `dependency`). Deterministic seed (`faker.seed(42)` at module init, or per-generation) so demo data is stable across reloads — good for screenshots and debugging.
- **npm scripts:** `"build:demo": "DEMO_MODE=1 rollup --config rollup.config.mjs"` and `"watch:demo": "DEMO_MODE=1 rollup --config rollup.config.mjs --watch"`. (No `cross-env` — repo is pnpm/rollup based; note Windows caveat in risks.)

### Alternatives considered

1. **Runtime flag (e.g. a `demo` key in `chrome.storage.sync`, toggle in the options page).** Rejected as primary approach: the issue says "a flag... running the app with this flag", and a runtime flag would ship Faker + demo data into every production bundle (bigger bundle, surface area in the shipped extension). Build-time keeps production bundles clean. *Could* be layered on later for a "try the demo" button in the store listing.
2. **Intercept in `background.ts` message handlers instead of the fetch layer.** Rejected: the alarm/badge path (`refreshPullRequests`) would still hit the real API. The fetch layer covers both paths with one seam.
3. **Separate demo entry points / separate rollup config for demo.** Rejected as over-engineering; the `replace` approach plus tree-shaking achieves the same with one config. (Fallback if tree-shaking proves insufficient — see risks.)
4. **Avatar providers:**
   - `pravatar.cc` — chosen. Real-looking photos, simple URL scheme, stable images, widely used.
   - `dicebear` (HTTP API, e.g. `https://api.dicebear.com/9.x/adrian/svg?seed=...`) — cartoon-style avatars; deterministic by seed; also fine, but doesn't match GitHub's photographic avatars as closely. Good fallback if pravatar availability is a concern.
   - `thispersondoesnotexist.com` — one image per visit, no stable per-user URL, slow, GAN artifacts; impractical for per-PR avatars. Rejected.
   - Faker's own `faker.image.avatar()` → uses a fixed set of cloudflare-hosted images; acceptable but less control. Not chosen.

## 4. Step-by-step implementation steps

### Step 0 — Add dependency
```bash
pnpm add @faker-js/faker
```

### Step 1 — `rollup.config.mjs`: inject the flag (modify)
```js
const isDemo = process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true';

// inside the existing replace({...}) plugin:
replace({
  'process.env.NODE_ENV': JSON.stringify('production'),
  'process.env.DEMO_MODE': JSON.stringify(isDemo ? 'true' : 'false'),
  preventAssignment: true,
}),
```

### Step 2 — Create `src/background/demoData.ts` (new file)
Sketch:
```ts
import { faker } from "@faker-js/faker";
import type { PullRequest, RepoError, FetchPullRequestsResult } from "./fetchPullRequests";

faker.seed(42); // deterministic demo data

const DEMO_REPOS = ["acme/widgets", "acme/platform", "globex/rocket-ui"];
const DEMO_USERNAME = "demo-user";

// pravatar images are numbered 1..70
const avatarUrl = () => `https://i.pravatar.cc/80?img=${faker.number.int({ min: 1, max: 70 })}`;

// stable per-login avatar so the same fake user always gets the same face
const avatarByLogin = new Map<string, string>();
function avatarFor(login: string): string {
  if (!avatarByLogin.has(login)) avatarByLogin.set(login, avatarUrl());
  return avatarByLogin.get(login)!;
}

function fakeUsers(count = 3) {
  return Array.from({ length: count }, () => {
    const login = faker.internet.username();
    return { login, avatar_url: avatarFor(login) };
  });
}

function fakePRsForRepo(repo: string, count: number, opts: { mine?: boolean }): PullRequest[] {
  return Array.from({ length: count }, (_, i) => {
    const author = opts.mine
      ? { login: DEMO_USERNAME, avatar_url: avatarFor(DEMO_USERNAME) }
      : fakeUsers(1)[0];
    const reviewers = fakeUsers(faker.number.int({ min: 1, max: 3 })).map((u) => ({ login: u.login }));
    return {
      id: faker.number.int({ min: 1_000_000, max: 9_999_999 }),
      number: faker.number.int({ min: 100, max: 9999 }),
      title: faker.hacker.phrase() /* or faker.company.catchPhrase() — pick a realistic PR-title generator */,
      html_url: `https://github.com/${repo}/pull/${number}` (use the generated number),
      user: author,
      created_at: faker.date.recent({ days: 14 }).toISOString(),
      updated_at: faker.date.recent({ days: 2 }).toISOString(),
      draft: faker.datatype.boolean({ probability: 0.25 }),
      requested_reviewers: reviewers,
      repo,
    } satisfies PullRequest;
  });
}

export async function demoFetchAuthenticatedUser(): Promise<string> {
  return DEMO_USERNAME;
}

export async function demoFetchOpenPullRequests(
  _token: string, repos: string[], username: string
): Promise<FetchPullRequestsResult> {
  const useRepos = repos.length ? repos : DEMO_REPOS;
  // mirror real filters: awaiting-review = requested_reviewers includes username
  const prs = useRepos.flatMap((repo) =>
    fakePRsForRepo(repo, faker.number.int({ min: 1, max: 6 }), { mine: false })
  ).map((pr) => ({ ...pr, requested_reviewers: [...pr.requested_reviewers, { login: username }] }));
  return { prs, errors: [] };
}

export async function demoFetchMyOpenPullRequests(
  _token: string, repos: string[], _username: string
): Promise<FetchPullRequestsResult> {
  const useRepos = repos.length ? repos : DEMO_REPOS;
  const prs = useRepos.flatMap((repo) =>
    fakePRsForRepo(repo, faker.number.int({ min: 0, max: 4 }), { mine: true })
  );
  return { prs, errors: [] };
}
```
Notes:
- Same async signatures/return types as the real fetchers so delegation is type-checked.
- Optionally simulate a small network delay (`await new Promise(r => setTimeout(r, 200))`) so the loading spinner path is also exercised in demo mode.
- Optionally (stretch): a `RepoError` with an SSO authorize URL on one repo to demo the SSO banner — keep off by default to avoid confusion.

### Step 3 — Modify `src/background/fetchPullRequests.ts`
At the top of each exported function:
```ts
import { demoFetchAuthenticatedUser, demoFetchOpenPullRequests, demoFetchMyOpenPullRequests } from "./demoData";

export async function fetchAuthenticatedUser(githubToken: string): Promise<string> {
  if (process.env.DEMO_MODE === "true") return demoFetchAuthenticatedUser();
  // ...existing body
}
// same pattern for fetchOpenPullRequests / fetchMyOpenPullRequests
```
Because `process.env.DEMO_MODE` is replaced with a literal `"false"` in normal builds, the demo branch (and, if rollup tree-shakes correctly, the faker import) drops out of production bundles.

### Step 4 — Modify `src/background/background.ts`
- In `refreshPullRequests()` (lines 22–31): in DEMO mode skip the `!githubToken || !repos.length || !username` guard and still call `fetchOpenPullRequests` so the badge shows a demo count:
  ```ts
  if (!process.env.DEMO_MODE && (!githubToken || !repos.length || !username)) { updateBadge(0); return; }
  ```
- In the startup `chrome.storage.sync.get` callback (lines 33–44) and the token-change listener (lines 52–61): skip the real `fetchAuthenticatedUser` when DEMO (the demo one returns instantly, but avoiding the call keeps the log output honest). Simplest: `username = process.env.DEMO_MODE ? "demo-user" : await fetchAuthenticatedUser(...)`.

### Step 5 — Modify `src/popover/popover.tsx`
In the data-loading `useEffect` (lines 55–79), guard the two early returns so demo mode still sends the message:
```ts
if (!process.env.DEMO_MODE && !stored.githubToken) { setState({ status: "no-token" }); return; }
if (!process.env.DEMO_MODE && !stored.repos?.length) { setState({ status: "no-repos" }); return; }
```
(The background's demo fetchers fall back to `DEMO_REPOS` when none are configured, so the popover's `repos` grouping still works — pass `stored.repos` through as today; for the `done` state in demo mode with empty repos, either use `DEMO_REPOS` in the response or render from `prs` unique repos.)

### Step 6 — `package.json`: add scripts
```json
"build:demo": "DEMO_MODE=1 rollup --config rollup.config.mjs",
"watch:demo": "DEMO_MODE=1 rollup --config rollup.config.mjs --watch"
```

### Step 7 — Changeset (repo uses changesets — `.changeset/` exists)
Add `.changeset/demo-mode-flag.md`:
```md
---
"github-reviews": minor
---
Added a DEMO build mode (`pnpm build:demo`) that renders fake Faker.js data with placeholder avatars instead of hitting the GitHub API.
```

## 5. Testing / verification steps

1. **Types:** `pnpm types` (tsc --noEmit) passes in both modes (the `replace`d literal must not break `strict` typing — `process.env.DEMO_MODE` needs `@types/node`'s `process.env` typing; already a devDependency, and rollup's replace handles the runtime value).
2. **Production build sanity:** `pnpm build`; confirm `build/js/background.js` does **not** contain faker code (`grep -c "faker" build/js/background.js` should be 0 or near-0; verify bundle size unchanged vs baseline). If faker leaks in, tree-shaking failed → see risks.
3. **Demo build:** `pnpm build:demo`.
4. **Manual verify in Chrome:**
   - Toggle Developer Mode → Load Unpacked → select `build/` (after demo build). Ensure **no GitHub token and no repos are configured** (clear extension storage or use a fresh profile) — this proves the guards are bypassed.
   - Open the toolbar popup: should show fake PRs with pravatar avatars, draft/ready icons, per-repo grouping, "Review Requests" ↔ "My Open PRs" toggle working.
   - Toolbar badge shows a non-zero count.
   - DevTools → Network tab on the popup and service worker: **no requests to `api.github.com`**; only `i.pravatar.cc` image loads.
   - Reload the popup: same fake data appears (deterministic seed).
   - Refresh button and mode toggle still function.
5. **Regression:** rebuild without the flag (`pnpm build`) on the same unpacked extension (with a real token + repos configured) and confirm real data still flows.

## 6. Risks and open questions

**Risks:**
- **Tree-shaking of faker in production builds.** The `if ("false")` branch should be dropped by rollup's constant folding, but only if the demo module has no side effects that force inclusion (faker's locale setup is a side effect — `faker.seed(42)` at module top-level certainly is). Mitigation: keep `faker.seed()` *inside* the generator functions or an init guard, and verify with `grep`/bundle-size check in step 5.2. Fallback plan: dynamic `import("@faker-js/faker")` inside the demo branch (rollup inlines dynamic imports for IIFE single-file output), or a `rollup.demo.config.mjs` variant. **This is the main technical risk to validate first.**
- **pravatar.cc availability** — third-party service; if down, avatars 404 (broken images). Mitigation: `onError` fallback on the `<img>` or switch to dicebear (also third-party). Truly offline alternative would be bundled placeholder SVGs, but the issue explicitly asks for "a known placeholder image provider."
- **Windows devs:** `DEMO_MODE=1` env-prefix syntax in npm scripts doesn't work in cmd.exe. Mitigation if needed: add `cross-env` devDependency (not planned initially).
- **Faker bundle size in demo build:** faker is large (~500KB+ minified with locales). Acceptable for a demo-only build; can import a single-locale subset (`@faker-js/faker/locale/en`) to trim.
- **Determinism vs. variety:** seeded faker gives the same PRs every build — great for screenshots, but the refresh button won't change data. Optional: re-seed per fetch call so refresh shows new data (trade-off; default to stable data, note the option).

**Open questions (for the maintainer):**
1. Should demo mode re-roll fake data on each refresh click, or keep it stable? (Plan default: stable/seeded.)
2. Should the popover display a visible "DEMO MODE" indicator (e.g. banner/label) so screenshots can't be mistaken for real data? Not required by the issue, but cheap to add — recommend yes.
3. Preferred avatar provider between pravatar (photos) and dicebear (illustrations)?
4. Should demo mode also fake the SSO-error path to demo that UI state, or keep errors empty?
