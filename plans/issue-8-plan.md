# Plan: Issue #8 — Cache fetched GitHub reviews so the popover isn't empty on first open

## 1. Issue summary (own words)

When the user opens the extension's popup, it always starts in a `loading` state and shows a spinner until a fresh round-trip to the GitHub API completes (cold service worker → load settings → fetch user → fetch PRs from N repos). We should persist the last successfully fetched review data so that on the next open the popup can render that data instantly, while fresh data is fetched to replace it.

## 2. Current behavior (exact references)

**What the "popover" actually is:** despite the name, `src/popover/popover.tsx` renders the extension **action popup** (`build/manifest.json` → `"action": { "default_popup": "index.html" }`). `src/content/content.ts` is currently an inert stub (a `chrome.runtime.onMessage` listener that only logs). There is no injected popover on pages — all UI is the toolbar popup.

**Data flow today:**

1. `src/popover/popover.tsx:29` — initial state is always `{ status: "loading" }` (spinner, "Loading pull requests…").
2. `src/popover/popover.tsx:46-70` — the fetch effect runs on mount, on refresh-button click, and on view-mode change. It reads settings from `chrome.storage.sync` (token/repos), then sends `chrome.runtime.sendMessage({ action: "GET_PULL_REQUESTS" | "GET_MY_PULL_REQUESTS" })` (`src/popover/popover.tsx:57-58`) and only leaves `loading` when the response arrives (`src/popover/popover.tsx:58-66`).
3. `src/background/background.ts:72-96` — the MV3 service worker handles those messages by calling `fetchOpenPullRequests` / `fetchMyOpenPullRequests` (`src/background/fetchPullRequests.ts:107-131`) against the live GitHub API, then `sendResponse`s the result. **The result is used only for the response + badge; nothing is persisted.**
4. `src/background/background.ts:22-33` — the service worker already polls every 5 minutes via `chrome.alarms` (`src/background/background.ts:48-54`) and calls `refreshPullRequests()`, which fetches open PRs but **discards everything except the badge count**.

**Result:** every popup open starts empty with a spinner; if the network is slow or the API errors, the user sees a spinner or error instead of the data they saw 2 minutes ago.

**Related latent bug worth knowing:** `src/background/background.ts:12-14` keeps `githubToken`/`repos`/`username` in service-worker memory, initialized asynchronously at `background.ts:36-45`. If the SW is killed (MV3 idle timeout) and cold-starts by an incoming `GET_PULL_REQUESTS` message, the top-level `chrome.storage.sync.get` may not have finished when the handler runs, so the fetch silently no-ops (`fetchPullRequests.ts:41-46` warns and returns empty). The cache masks the *symptom* but not the *cause* — see Risks.

## 3. Proposed design

### Storage choice: `chrome.storage.local`

- **`chrome.storage.local`** (chosen): persists across service-worker restarts *and* browser restarts; accessible from both the SW and the popup (extension pages are trusted contexts); 10 MB quota (Chrome ≥ 114; 5 MB older) — ample for a few hundred PR objects; already permitted (`"storage"` in manifest).
- **`chrome.storage.session`** — rejected: cleared when the browser closes; also requires `chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })` if content scripts ever need it. We want cross-session persistence.
- **`localStorage`** — rejected: MV3 service workers have no `localStorage`/window, so the background writer (`background.ts`) couldn't use it.
- **`chrome.storage.sync`** — rejected: settings live here, but sync quota is ~8 KB per item / 102 KB total and rate-limited to 100 writes per 10 min (worse with a 5-min poll writing two entries). A `per_page=100` PR list can exceed 8 KB on its own.
- **IndexedDB** — rejected as overkill: flat, small, structured data; `chrome.storage.local` is simpler and already used in the codebase.

### Cache schema

New module `src/background/reviewCache.ts` owns the schema and read/write helpers (shared by background and popover):

```ts
// src/background/reviewCache.ts
import type { PullRequest, RepoError } from "./fetchPullRequests";

export type CacheKey = "review" | "mine"; // matches popover ViewMode

export interface CacheEntry {
  prs: PullRequest[];
  errors: RepoError[];
  repos: string[];     // snapshot of the repos setting used for this fetch
  fetchedAt: number;   // Date.now() epoch ms
}

export const CACHE_STORAGE_KEY = "prCache"; // under chrome.storage.local

type StoredCache = Partial<Record<CacheKey, CacheEntry>>;

export function readCache(key: CacheKey): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_STORAGE_KEY], (stored) => {
      resolve((stored[CACHE_STORAGE_KEY] as StoredCache)?.[key] ?? null);
    });
  });
}

export function writeCache(key: CacheKey, entry: CacheEntry): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_STORAGE_KEY], (stored) => {
      const cache = (stored[CACHE_STORAGE_KEY] as StoredCache) ?? {};
      cache[key] = entry;
      chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache }, () => resolve());
    });
  });
}

export function clearCache(): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.remove(CACHE_STORAGE_KEY, () => resolve()));
}
```

Note: `viewMode` already lives in `chrome.storage.local` (`popover.tsx:34-43`) — one object store in that area is consistent with existing usage.

### Write points (background)

1. **Message handlers** (`background.ts:72-96`): after each successful `fetchOpenPullRequests` / `fetchMyOpenPullRequests`, `writeCache(...)` with the result, current `repos`, and `fetchedAt: Date.now()`.
2. **Alarm poller** (`background.ts:22-33`): `refreshPullRequests()` already fetches the "review" data every 5 min for the badge — extend it to also `writeCache("review", ...)`. This is what makes the cache warm even if the user hasn't opened the popup recently. (Caching "mine" from the poll too is an open question — see §6.)

### Read point + render strategy (popover)

Stale-while-revalidate, minimal version (auto-fetch lifecycle wiring is issue #9's job; this plan keeps the existing explicit fetch effect):

- On mount / view-mode change, **before** kicking off the live fetch, `readCache(viewMode)` and, if an entry exists whose `entry.repos` matches the current `stored.repos`, immediately `setState({ status: "done", prs, errors, repos, fetchedAt })`.
- Then run the existing fetch flow unchanged; when the fresh response lands it overwrites the state (and the background re-writes the cache).
- Keep the spinner only when **no** cache hit exists.
- Add a small staleness affordance in `done` state: e.g. `Text size="small"` "Updated 3m ago" (computed from `fetchedAt`), or at minimum render cached data without interruption and let the refresh button (and #9's auto-refresh) update it. Recommended: include the "Updated Xm ago" label because it's cheap and prevents confusion between stale and fresh data.

### Invalidation

Two complementary guards:

1. **On settings change** — in the existing `chrome.storage.onChanged` listener (`background.ts:56-70`), if `changes.githubToken` or `changes.repos` fired, call `clearCache()`. A token change can mean a different user; a repos change makes cached per-repo groupings wrong.
2. **On read** (defense in depth) — the popover compares `cachedEntry.repos` with current `stored.repos`; on mismatch, treat as a cache miss. This covers the case where the popup reads storage before the background's `onChanged` handler has cleared it.

No TTL is proposed: the alarm poll keeps the cache ≤ 5 min old in practice, and issue #9 will make every open trigger a refresh. A TTL would only decide between "spinner" and "5-minute-old data" — showing the data is the point of this issue. (Alternative considered and rejected: TTL-based `STALE` state that hides data older than, say, 1 hour. Can be added later by checking `Date.now() - fetchedAt`.)

### Alternatives considered (summary)

| Alternative | Why rejected |
|---|---|
| `chrome.storage.session` | Cleared on browser close; no cross-session persistence |
| `localStorage` (popup) | Unavailable in MV3 service worker — background can't write |
| `chrome.storage.sync` | 8 KB/item quota, 100 writes/10 min — PR lists + 5-min poll exceed it; sync is for settings |
| IndexedDB | Overkill for one small flat object |
| Cache only the badge count / render skeleton | Doesn't satisfy "popover has data to show immediately" |
| TTL-gated cache | Unnecessary given 5-min poll + #9's fetch-on-open; keep display simple |

## 4. Implementation steps

**Step 1 — Create `src/background/reviewCache.ts`** with the schema and helpers shown in §3. (New file; no other file's exports change.)

**Step 2 — Background: write cache on message fetches.** In `src/background/background.ts:72-96`, in both `GET_PULL_REQUESTS` and `GET_MY_PULL_REQUESTS` handlers, after a successful fetch:

```ts
if (message.action === "GET_PULL_REQUESTS") {
  fetchOpenPullRequests(githubToken, repos, username).then(({ prs, errors }) => {
    updateBadge(prs.length);
    writeCache("review", { prs, errors, repos, fetchedAt: Date.now() }); // NEW
    sendResponse({ action: "PULL_REQUESTS", payload: prs, errors });
  });
  return true;
}
// same pattern for GET_MY_PULL_REQUESTS → writeCache("mine", ...)
```

(Fire-and-forget is fine; storage writes are fast and the response shouldn't wait on them.)

**Step 3 — Background: write cache from the 5-min poll.** In `refreshPullRequests()` (`background.ts:22-33`):

```ts
async function refreshPullRequests() {
  if (!githubToken || !repos.length || !username) { updateBadge(0); return; }
  try {
    const { prs, errors } = await fetchOpenPullRequests(githubToken, repos, username);
    updateBadge(prs.length);
    writeCache("review", { prs, errors, repos, fetchedAt: Date.now() }); // NEW
  } catch (e) {
    console.error("[BACKGROUND] badge refresh failed:", e);
  }
}
```

**Step 4 — Background: invalidate cache on settings change.** In the `chrome.storage.onChanged` listener (`background.ts:56-70`), before the existing per-change handling:

```ts
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (changes.githubToken || changes.repos) {
    clearCache(); // NEW — cached PRs belong to old settings
  }
  // ...existing logic unchanged...
});
```

**Step 5 — Popover: extend the `State` type and read cache first.** In `src/popover/popover.tsx`:

- Extend the `done` state to carry `fetchedAt?: number` (and keep `loading` only as the no-cache path):

```ts
type State =
  | { status: "loading" }
  | { status: "no-token" }
  | { status: "no-repos" }
  | { status: "done"; prs: PullRequest[]; errors: RepoError[]; repos: string[]; fetchedAt?: number }
  | { status: "error"; message: string };
```

- In the fetch effect (`popover.tsx:46-70`), after the settings guard and before `sendMessage`:

```ts
const cached = await readCache(viewMode);
if (cached && arraysEqual(cached.repos, stored.repos)) {
  setState({ status: "done", prs: cached.prs, errors: cached.errors, repos: stored.repos, fetchedAt: cached.fetchedAt });
} else {
  setState({ status: "loading" });
}
// then the existing chrome.runtime.sendMessage flow, unchanged
```

(If the team prefers to avoid `async/await` in this effect, the same can be done with nested callbacks matching the file's existing callback style. A tiny local `arraysEqual` avoids `[1,2].join()`-style hacks; or compare `JSON.stringify` since repos are plain strings.)

- Render "Updated Xm ago" in `done` state when `fetchedAt` is present (a small `Text` next to the header or above the list; compute minutes via `Math.max(1, Math.round((Date.now() - fetchedAt) / 60000))`).

**Step 6 — Type check.** Ensure `readCache`/`writeCache` import cleanly into the popover bundle (rollup `popover.js` input already compiles shared modules; `fetchPullRequests.ts` types are already imported there).

No manifest changes needed — `"storage"` permission already present.

## 5. Testing / verification

1. `pnpm types` (`tsc --noEmit`) — no type errors.
2. `pnpm build` — builds clean; confirm `build/js/popover.js` and `build/js/background.js` updated.
3. Manual, in Chrome (`chrome://extensions` → Developer mode → Load unpacked → `build/`):
   - **First ever open (cold cache):** click the toolbar icon with token + repos configured → spinner → data appears (unchanged behavior).
   - **Reopen (cache hit — the core fix):** close popup, reopen → PR list renders immediately (no spinner), "Updated Xm ago" label present; fresh data silently replaces it moments later.
   - **Refresh button:** click refresh → data reloads; close/reopen → cache reflects the refreshed data.
   - **View-mode switch:** switch to "My Open PRs" with no `mine` cache → spinner the first time; switch back to "Review Requests" → instant cached render; switch to "mine" again → instant.
   - **Settings invalidation:** in options, remove a repo (or paste a different token) → storage change fires → reopen popup → no stale repo group shown (cache miss → spinner → fresh data).
   - **Service-worker restart:** at `chrome://extensions`, kill the SW (or wait ~30 s idle), reopen popup → cached data still renders instantly (proves persistence isn't in SW memory).
   - **Browser restart:** quit/relaunch Chrome, open popup → cached data still renders (proves `storage.local`, not `session`).
   - **Offline/API error:** with cache warm, disconnect network, open popup, click refresh → cached data remains visible with error state only if the fetch actually errors (per current UX, the error replaces the list — acceptable; an open question below covers "keep stale data on error").
4. Inspect cache contents: extension DevTools → Application → Extension Storage → Local → `prCache`.

## 6. Risks and open questions

- **Cold-start race in the background SW (pre-existing bug, out of scope but adjacent):** `background.ts:12-14` in-memory settings may still be empty when a message arrives after SW restart, so a "fresh" fetch can return empty and overwrite a good cache with an empty one. Mitigation within this issue: only `writeCache` when `githubToken && repos.length && username` are set (skip otherwise). Proper fix — read settings inside the message handler — overlaps issue #9's fetch-on-open work; recommend coordinating the two issues.
- **Should a failed/empty fetch overwrite the cache?** Plan assumes "yes, cache mirrors last fetch" (keeps cache honest and simple). Alternative: keep the previous entry if the new fetch returns errors. Decide during implementation review.
- **Should the 5-min alarm also cache "mine" data?** Currently the poll only fetches review-request PRs (for the badge). Caching `mine` from the poll doubles API calls every 5 min (rate-limit consideration, ~2 requests/repo/poll). Default plan: cache `mine` only from on-demand message fetches. If users heavily use "My Open PRs", extend the poll.
- **Storage size:** worst case ~2 × (100 PRs × N repos) JSON. At `per_page=100` this is fine within the 10 MB `storage.local` quota for any realistic repo count, but note `writeCache` does read-modify-write of the whole `prCache` object — fine at this size.
- **Clock skew for "Updated Xm ago":** `Date.now()` from the same machine is used on both write and read, so it's consistent.
- **Coordination with #9:** this plan intentionally leaves the fetch-trigger lifecycle untouched (manual refresh still required for live data). Issue #9 will move the fetch into the render lifecycle; the `done + fetchedAt` state introduced here is designed to compose with that (show cached → swap in fresh).
