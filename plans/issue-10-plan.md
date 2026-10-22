# Plan: Issue #10 — Some private repos don't show PRs (e.g. `10gen/mms`)

## 1. Issue summary (own words)

For large repos the popup shows the empty state ("No pull requests awaiting your review." / "No open pull requests.") even when the user has matching PRs. The issue guessed SSO, but it turned out to be pagination.

## 2. Root cause (verified 2026-09-25)

`src/background/fetchPullRequests.ts` calls `GET /repos/{repo}/pulls?state=open&per_page=100` once and never follows the `Link` header. Then it filters on the client.

Measured with `gh api` against `10gen/mms`:

- The `Link` header shows `rel="last"` = page 16. There are **1,545 open PRs**, and the extension sees only the newest 100.
- The user's 4 open PRs (#188865, #185128, #167601, #161857) sit at positions **234, 698, 1344 and 1504**. All of them are outside page 1, so "My PRs" is always empty.
- There is a second defect: the review filter checks only `requested_reviewers` (individuals). It ignores `requested_teams`, so a CODEOWNERS team request never matches.
- A third, smaller defect: rejected fetches (network error, bad JSON) are `console.error`'d in the `allSettled` loop and dropped. The repo then renders the empty state with no error.

SSO is not the cause here. The mms request returned 200.

## 3. Proposed design: Search API

Replace the `/pulls` listing with **one Search query per repo per view**:

| View | Query |
| --- | --- |
| `review` | `repo:{repo} is:pr is:open review-requested:{username}` |
| `mine` | `repo:{repo} is:pr is:open author:{username}` |

`GET https://api.github.com/search/issues?q=<encoded>&per_page=100`

- GitHub filters on the server, so pagination stops mattering in practice. 100 matching PRs per repo per view is plenty. If `total_count > 100`, log a warning; don't paginate.
- `review-requested:` matches **team requests as well as individual ones**. `user-review-requested:` would be the individual-only form. This fixes defect #2 for free.
- Use the explicit `username` (already cached in `githubUsername`) rather than `@me`. That keeps queries identical to what the unit tests and the e2e stub assert. Either works.
- Keep **per-repo** queries rather than one combined `repo:a repo:b` query. A combined query fails the whole request (422) if any single repo is inaccessible, and we'd lose the per-repo error buckets and the SSO link.

### Response mapping

Search items are issue-shaped. The fields the UI uses (`id`, `number`, `title`, `html_url`, `user.login`, `user.avatar_url`, `created_at`, `updated_at`, `draft`) all exist on the item. I confirmed `draft` is present on a live mms item. Differences:

- `requested_reviewers` is **absent**. Remove it from `PullRequest` (it's only used for client-side filtering, which goes away) or make it optional. Prefer removing.
- `repo` is still derived from the loop variable, as today. `repository_url` is available as a cross-check.
- `id` is the issue id, not the pull id. It's still unique, and it's only used as a React key and in the cache.

Delete the `filter` parameter from `fetchPRsFromRepos` and pass the qualifier instead (`review-requested:` vs `author:`).

### Error handling

- Keep the SSO header parsing unchanged. Search returns 403 with `X-GitHub-SSO` in the same way.
- A **422** means the repo was not found or is inaccessible to the token. Map it to a readable message ("Repo not found or token lacks access") so fine-grained-PAT misconfigurations are visible.
- **Rate limit:** Search allows 30 requests/min when authenticated. Per refresh that's `repos.length` requests per view (the alarm refreshes the review view only). On a 403/429 with `x-ratelimit-remaining: 0`, emit a per-repo error such as "GitHub search rate limit hit — retry in Ns" (from `x-ratelimit-reset`) instead of the generic status text.
- Fix defect #3: in the `allSettled` loop, turn `rejected` results into a `RepoError` for that repo instead of just logging them. That needs the repo name, so zip `results` with `repos`.

## 4. Files to change

- `src/background/fetchPullRequests.ts`: new URL builder, drop `filter`, parse `.items`, 422/rate-limit messages, rejected → `RepoError`, drop `requested_reviewers` from `PullRequest`.
- `src/background/demoData.ts`: remove `requested_reviewers` from generated PRs. `demoRawPullsForRepo` becomes a demo *search* response `{ total_count, incomplete_results: false, items }`, and the demo fetchers keep their current filtering internally.
- `e2e/stub/server.ts`: serve `GET /search/issues`. Parse `repo:` and `review-requested:` / `author:` out of `q`, and return only matching items so the stub mirrors server-side filtering.
- `e2e/popup.spec.ts:63`: the assertion on `requested_reviewers` no longer applies. Assert that the stub received a `review-requested:demo-user` query instead, or assert on the rendered PR titles.
- `test/unit/fetchPullRequests.test.ts`, `test/unit/background.test.ts`: update URL helpers and fixtures to the search shape. Add tests for:
  - the query string per view (`review-requested:` / `author:`, correct `repo:`, URL-encoded)
  - the `items` mapping including `repo`
  - 422 → access message
  - rate-limit → retry message
  - a rejected fetch → a `RepoError` (not a silent empty repo)
  - the SSO header path still produces `ssoAuthorizeUrl`
- `AGENTS.md`: update the stub description (`GET /search/issues`) and the `fetchPullRequests` test coverage note.
- `.changeset/`: `patch`, "Fetch PRs via the Search API so large repos and team review requests show up (#10)".

## 5. Verification

1. `pnpm types`, `pnpm test:unit`, `pnpm test:e2e`.
2. `pnpm build`, then run the existing AGENTS.md bundle greps (no demo artifacts in prod; guards present).
3. Manual check: load the unpacked build with `10gen/mms` configured. "My PRs" should list #188865, #185128, #167601 and #161857. Cross-check the review view against `gh api "search/issues?q=repo:10gen/mms+is:pr+is:open+review-requested:TheSonOfThomp" --jq .total_count`.

## 6. Risks / trade-offs

- **Search index lag:** new PRs or review requests can take from a few seconds up to about a minute to appear. That's acceptable for a 5-minute poll.
- **Rate limit:** 30/min caps a single refresh at about 30 repos. This is fine for current usage. If it becomes a problem, batch repos into combined queries and fall back to per-repo queries only when the batch returns 422.
- **Semantics change:** the review view now includes team requests. That's probably what users want, but it may be noisy for people on large teams. A future setting could switch to `user-review-requested:` (individual requests only). Out of scope here.
- **Re-requested reviews:** after you submit a review, GitHub drops you from the request until the author re-requests, same as today. There's no behavior change.
