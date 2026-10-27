# Plan: Issue #39 — Show review status for “My Open PRs”

## Summary

Add one accessible status icon to each **My Open PRs** row, showing the PR author whether it is **Approved**, **Awaiting review**, **Changes requested**, or has **Comments pending**. Do not change the Review Requests tab.

## Scope and existing integration points

- `src/background/fetchPullRequests.ts` already enriches Search API PRs through one chunked GraphQL `nodes(ids:)` request per refresh. This is the shared source of truth for optional row metadata and cached results.
- `src/background/reviewCache.ts` persists the whole `PullRequest`, so a new optional field will automatically participate in cache-first rendering without a cache migration.
- `src/popover/popover.tsx` already renders CI icons from metadata in both views; the new indicator should follow that compact, token-based, accessible pattern but render only when `viewMode === "mine"`.
- DEMO mode bypasses GraphQL, while browser E2E runs production-mode code against `e2e/stub/server.ts`; both need deterministic review-status data.
- No settings, API routes, cache keys, or additional dependency are needed.

## Status semantics

**“Comments pending” means a reviewer’s latest submitted review has `state === COMMENTED`**—not an unresolved pull-request review thread.

Proposed exclusive status precedence:

1. `changes-requested` — `reviewDecision === CHANGES_REQUESTED`
2. `comments-pending` — a `COMMENTED` review appears in GitHub’s per-reviewer latest-review set
3. `approved` — `reviewDecision === APPROVED`
4. `awaiting-review` — `reviewDecision === REVIEW_REQUIRED` or `null` / no decision

Using `latestReviews` avoids retaining a stale commented state after that same reviewer later approves or requests changes. Changes requested remains the most actionable state when review outcomes conflict.

## Implementation steps

1. **Extend the existing GraphQL enrichment in `src/background/fetchPullRequests.ts`.**
   - Add a `ReviewStatus` union to `PullRequest` and `PrEnrichment`; keep it optional so old cached entries continue rendering.
   - Extend `PR_ENRICHMENT_QUERY`’s `PullRequest` selection with `reviewDecision` and `latestReviews(first: 100) { nodes { state } }`, alongside the existing CI and timeline fields.
   - Expand the local GraphQL response type for those fields and add a small pure mapper from `reviewDecision` plus latest review states to the four UI statuses above.
   - Assign the mapped status during the existing enrichment loop. Preserve the current graceful degradation: a failed GraphQL request leaves the PR list usable and simply omits these icons.
   - Keep the existing 100-node query chunking. Do not add one REST request per PR.

2. **Render the My Open PRs indicator in `src/popover/popover.tsx`.**
   - Add a small status-to-icon metadata map using Primer/Octicons icons and functional color tokens, matching the existing `CIStatusLink` conventions.
   - Render an icon only in the `mine` view and only if enrichment provided a status. Give it a descriptive `title` and `aria-label` (for example, `Review status: Changes requested`); it is informational, not a separate link.
   - Place it with the existing right-side metadata (wait time and CI) without changing PR link behavior or the Review Requests tab.

3. **Keep demo and E2E data deterministic.**
   - `src/background/demoData.ts`: add a stable mix of the four `review_status` values to My Open PR demo PRs, including a comments-pending case. This lets DEMO builds exercise the visual treatment without production GraphQL.
   - `e2e/stub/server.ts`: extend the existing `/graphql` response to return deterministic `reviewDecision` and `latestReviews` states per node ID, and ensure it can yield all mapper inputs. Keep the current CI/timeline response behavior unchanged.

4. **Cover the behavior at the correct levels.**
   - `test/unit/fetchPullRequests.test.ts`: table-test the mapper for approved, review required/null, changes requested, a latest `COMMENTED` review overriding approval/awaiting review, and a later non-commented review clearing that commenter’s pending-comment state. Update the GraphQL response fixture and assert `fetchPrEnrichments` attaches `review_status` while retaining CI and timing enrichments.
   - `e2e/popup.spec.ts`: in the My Open PRs flow, read the cached PR statuses and assert visible rows with a status have the expected accessible review-status icon; assert Review Requests has no review-status icons. Continue asserting CI behavior separately.
   - Add or update the focused popup-render screenshot annotation only if the visual review needs to display the new indicator; do not broaden unrelated E2E coverage.

5. **Release metadata and documentation.**
   - Add one patch changeset describing review-status indicators for My Open PRs.
   - Update the fine-grained-PAT guidance only if the implementation proves `Pull requests: Read` is insufficient. It is already documented and should cover `reviewDecision` and review threads, so no settings-page change is expected.

## Verification

1. Run `pnpm types` and `pnpm test:unit`.
2. Run `pnpm test:e2e` and verify light and dark projects, My Open PR accessible labels, absence from Review Requests, and cache-first data carrying the optional status.
3. Run `pnpm build`; confirm the existing production-bundle checks from `AGENTS.md` still pass (no demo artifacts, guards retained, and cache code present).
4. Run `pnpm build:demo` to visually confirm all four states are represented, then restore the normal production build with `pnpm build`.

## Risks and limits

- `latestReviews(first: 100)` can omit a reviewer on a PR with more than 100 reviewers. This is an acceptable bounded query for the popup; if it becomes material, paginate the connection.
- `reviewDecision` reflects GitHub’s merge/review policy and can be `null` for repositories without required reviews. Treating that as Awaiting review is the useful author-facing fallback, but it is not proof that a reviewer was explicitly requested.
- Any GraphQL scope/rate-limit/network failure retains current behavior: rows render without review-status (and CI/timing) enrichment rather than blocking the popup.
