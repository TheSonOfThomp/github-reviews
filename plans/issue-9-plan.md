# Implementation Plan — Issue #9: Fetch new review data at the right point in render so popover isn't empty on open

> **DECISION (2026-09-16, implemented in PR #19): ROOT CAUSE CONFIRMED — fix implemented on `fix/sw-cold-start-race`.** Lab evidence at https://github.com/TheSonOfThomp/github-reviews/issues/9 — cold SW serves GET_PULL_REQUESTS with `username=""` → 200-OK-empty rendered as done; cache render gets clobbered by the racy response. The fix keeps fetches in the SW: a module-level `settingsReady` promise (storage reads only) awaited by GET_* handlers, username persisted in `chrome.storage.local` so cold starts make no `/user` round trip, and startup badge refresh skipped when the cache is fresh. Also targets #16 (network-free SW startup critical path). Lab-verified: first run waits for `/user` and returns correct data; with cached username, correct data in 109ms while `/user` would take 8s; fresh-cache startup does zero network.
>
> Note from #8's implementation: #8 landed with a `hasSettings()` guard in the background that skips cache writes when module-scope settings are empty (mitigating the cold-start race described in §2 below), and the popover now reads the cache before fetching. When picking this up, reconcile this plan's `getSettings()` promise fix with the maintainer's React-render-cycle direction — the two approaches are complementary: awaiting settings inside the message handler fixes the empty-response race, while moving the calls in the render cycle determines when fresh data is requested.

> Plan only — no implementation in this change. Related to #8 (cache fetched reviews).

## 1. Issue summary (own words)

When the user opens the extension's popover (the action popup), it renders with no review data, and the user must click the manual Refresh button before any PRs appear. We need the popover to show data on open without a manual click — i.e. the fetch that already happens during the popover's mount lifecycle must actually deliver fresh data.

## 2. Current behavior (with exact file/line references)

### What already works

The popover already fetches on mount — the "right point in the render lifecycle" exists today:

- `src/popover/popover.tsx:33-39` — first `useEffect` reads persisted `viewMode` from `chrome.storage.local`.
- `src/popover/popover.tsx:44-66` — second `useEffect` (deps `[refreshCount, viewMode]`):
  - bails while `viewMode === null` (line 45) — i.e. waits for storage read to complete;
  - reads `githubToken`/`repos` from `chrome.storage.sync` (lines 47-56) and sets `no-token` / `no-repos` states;
  - sends `GET_PULL_REQUESTS` / `GET_MY_PULL_REQUESTS` to the background (lines 57-65) and renders the response.
- `src/popover/popover.tsx:70` — `handleRefresh` only increments `refreshCount`, re-running that same effect.
- The popup is a real action popup (`build/manifest.json` → `"action": { "default_popup": "index.html" }`), so it mounts fresh on every open — the mount effect runs every time the popover opens.

So the popover *does* request data on open. The bug is that this request returns an **empty-but-successful** result, which the popover renders as "done" with zero PRs.

### Root cause: racy settings cache in the background service worker

`src/background/background.ts` keeps settings in module-scope variables:

- `src/background/background.ts:12-14` — `let githubToken = ""; let repos: string[] = []; let username = "";` (all start empty).
- `src/background/background.ts:36-45` — a top-level `chrome.storage.sync.get(...)` populates them asynchronously, and `username` additionally requires a **network call** (`fetchAuthenticatedUser`, line 40) — hundreds of ms.

The message handler runs immediately when a message arrives, using whatever the module-scope variables happen to contain:

- `src/background/background.ts:72-83` — `GET_PULL_REQUESTS` handler calls `fetchOpenPullRequests(githubToken, repos, username)` with the *current* (possibly still-empty) values and returns `true` to hold the response channel open.
- `src/background/background.ts:85-93` — same pattern for `GET_MY_PULL_REQUESTS`.

The failure sequence (reproduces almost every open in practice):

1. MV3 service workers are terminated after ~30s idle. The popup is usually opened long after that, so `chrome.runtime.sendMessage` **wakes a cold service worker**.
2. The top-level code runs synchronously (registering listeners), then the message is dispatched — but the async `chrome.storage.sync.get` callback (and especially the `fetchAuthenticatedUser` network call) has not completed yet.
3. `fetchOpenPullRequests("", [], "")` hits the silent early-return guards in `src/background/fetchPullRequests.ts:49-55` (`if (!githubToken) ... return { prs: [], errors: [] }`) — **no error is surfaced**.
4. Even if `githubToken`/`repos` load in time, an empty `username` still yields zero results: the review filter at `src/background/fetchPullRequests.ts:139` (`pr.requested_reviewers.some((r) => r.login === user)`) matches nothing when `user === ""`.
5. The background responds `{ action: "PULL_REQUESTS", payload: [], errors: [] }`, and the popover transitions to `status: "done"` with an empty `prs` array (`src/popover/popover.tsx:64-65`) — rendering "No pull requests awaiting your review." with no spinner and no error.
6. By the time the user clicks Refresh, the startup `storage.sync.get`/`fetchAuthenticatedUser` have finished, so the second request succeeds — which is exactly the observed "works only after manual refresh" behavior.

Secondary issue: when the token is set but `fetchAuthenticatedUser` fails (network hiccup, expired token), `username` silently becomes `""` (`.catch(() => "")` at `src/background/background.ts:40` and `:60-62`), producing the same fake-empty result forever, not just on cold start.

## 3. Proposed design

**Principle: the message handler must never answer from partially-initialized state.** Make the background's settings load a shared, awaited promise, and persist the resolved username so a cold service worker doesn't need a network round-trip before it can answer.

The popover's existing mount-time effect is the correct render-lifecycle trigger and stays as-is (it is already "fetch on open"). The fix is entirely in guaranteeing that fetch returns real data.

### Design details

**Background (`src/background/background.ts`):**

- Replace the three module-scope `let` variables with a single cached promise `getSettings()`:
  - reads `githubToken`/`repos` from `chrome.storage.sync`;
  - reads a persisted `username` from `chrome.storage.local` (new);
  - if a token exists but no cached username, resolves it via `fetchAuthenticatedUser` and writes it back to `chrome.storage.local` so subsequent cold starts are instant;
  - if the username cannot be resolved, the handler returns an explicit error response instead of an empty success.
- `chrome.storage.onChanged` (currently lines 55-68) invalidates/rebuilds the cached promise when `githubToken`/`repos` change, and clears the persisted username when the token changes.
- Both `GET_PULL_REQUESTS` and `GET_MY_PULL_REQUESTS` handlers `await getSettings()` before fetching. Concurrent callers (popup + alarm) share the same in-flight promise.
- `refreshPullRequests` (lines 23-33) and `storage.onChanged` also use `getSettings()` instead of the raw variables.

**Response protocol:** extend the response shape with an optional top-level `error` field (`{ action, payload, errors, error? }`) used only for "settings not usable" cases (no username). The popover already has an `error` state (`src/popover/popover.tsx:25`) — it maps this field onto it.

**Composition with #8 (cache layer):** this fix and #8 are complementary and compose at two seams:

1. **First paint:** #8 persists the last fetched result (e.g. `chrome.storage.local` keys `cachedPullRequests` / `cachedMyPullRequests` with a `fetchedAt` timestamp, written by the background after every successful fetch — including the 5-minute alarm refresh at `src/background/background.ts:47-53`). On mount, the popover reads the cache for its `viewMode` *before/while* sending `GET_*`, so the first frame shows stale-but-real data instead of a spinner.
2. **Fresh data:** #9 (this plan) guarantees the mount-time `GET_*` actually returns fresh results, which then replace the cached view and update the cache.

The popover state machine should support `done(stale, from cache)` → `loading(refresh)` → `done(fresh)` rather than resetting to a bare spinner when cached data exists. #9's scope is making the network leg reliable; the cache read/write belongs to #8 — the storage-key contract above is the coordination point between the two plans.

### Alternatives considered

- **Fetch directly from the popover** (skip the background): the popup page has `host_permissions` for `api.github.com`, so it could fetch itself and would read settings straight from storage. Rejected: duplicates fetch/SSO-error logic in two contexts, breaks badge updates (`updateBadge` runs in the background at `src/background/background.ts:16-21, 79`), and fragments #8's cache into two writers.
- **Keep module-scope vars, but have the handler `await` an `initialized` flag** (e.g. a promise resolved by the existing top-level `storage.sync.get`). Simpler, but rejected: the username still needs a network call on every cold start, and failure still silently yields `""`.
- **Pre-warm via `chrome.action.onClicked`.** Not applicable: with `default_popup` set, `onClicked` never fires.
- **Rely purely on #8's cache** (serve cached data, refresh in background). Insufficient alone: first-ever open, token/SSO changes, and stale data still need a reliable on-open fetch — and the on-open fetch is precisely what's broken today.

## 4. Step-by-step implementation steps

### Step 1 — Background: promise-based settings with persisted username

Modify `src/background/background.ts`. Replace lines 12-14 and the top-level `storage.sync.get` block (lines 36-45) with:

```ts
interface Settings {
  githubToken: string;
  repos: string[];
  username: string;
}

let settingsPromise: Promise<Settings> | null = null;

async function loadSettings(): Promise<Settings> {
  const sync = await chrome.storage.sync.get({ githubToken: "", repos: [] });
  const local = await chrome.storage.local.get({ username: "" });
  let username = local.username as string;

  if (sync.githubToken && !username) {
    username = await fetchAuthenticatedUser(sync.githubToken).catch(() => "");
    if (username) {
      chrome.storage.local.set({ username });
    }
  }
  console.log("[BACKGROUND] loaded settings, user:", username || "(unresolved)");
  return { githubToken: sync.githubToken, repos: sync.repos ?? [], username };
}

function getSettings(): Promise<Settings> {
  settingsPromise ??= loadSettings();
  return settingsPromise;
}
```

Update `refreshPullRequests` (lines 23-33) to `const { githubToken, repos, username } = await getSettings();` at the top.

### Step 2 — Background: await settings in the message handler

Rewrite the `chrome.runtime.onMessage` listener (lines 72-95):

```ts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "GET_PULL_REQUESTS" && message.action !== "GET_MY_PULL_REQUESTS") {
    return true;
  }

  getSettings().then(async (settings) => {
    if (!settings.githubToken || !settings.repos.length) {
      sendResponse({ action: message.action, payload: [], errors: [], error: "Settings missing or incomplete" });
      return;
    }
    if (!settings.username) {
      sendResponse({ action: message.action, payload: [], errors: [], error: "Could not resolve GitHub username — check your token in settings" });
      return;
    }
    const fetcher = message.action === "GET_PULL_REQUESTS" ? fetchOpenPullRequests : fetchMyOpenPullRequests;
    const { prs, errors } = await fetcher(settings.githubToken, settings.repos, settings.username);
    if (message.action === "GET_PULL_REQUESTS") updateBadge(prs.length);
    // Seam for #8: also write { prs, errors, fetchedAt: Date.now() } to chrome.storage.local here.
    sendResponse({ action: message.action, payload: prs, errors });
  });

  return true;
});
```

### Step 3 — Background: invalidate the cache on settings change

Rewrite the `chrome.storage.onChanged` listener (lines 55-68):

```ts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    settingsPromise = null; // force reload on next getSettings()
    if (changes.githubToken) {
      chrome.storage.local.remove("username"); // stale username for a new token
    }
    refreshPullRequests();
  }
});
```

### Step 4 — Popover: surface handler-level errors (and cache seam for #8)

Modify `src/popover/popover.tsx`:

- In the `sendMessage` callback (lines 58-65), check the new top-level `error` field first and map it to the existing `error` state:

```ts
chrome.runtime.sendMessage({ action }, (response) => {
  if (chrome.runtime.lastError) {
    setState({ status: "error", message: chrome.runtime.lastError.message ?? "Unknown error" });
    return;
  }
  if (response?.error) {
    setState({ status: "error", message: response.error });
    return;
  }
  setState({ status: "done", prs: response?.payload ?? [], errors: response?.errors ?? [], repos: stored.repos });
});
```

- (Only if #8 lands first or in the same release, per its plan) read the cache in the mount effect before sending `GET_*`, rendering it as `done` data and letting the network response replace it. No popover change is *required* for #9 alone.

### Step 5 — No changes needed

- `src/popover/index.tsx` — mounting is fine.
- `src/content/content.ts` — currently a no-op message listener; not part of this flow (the popover is an extension popup, not injected by the content script).
- `src/background/fetchPullRequests.ts` — its early-return guards (lines 49-55) become unreachable from the message path once the handler pre-validates settings; leave them as defense-in-depth.
- `build/manifest.json` — `storage` permission already covers `chrome.storage.local`; no manifest change.

## 5. Testing / verification

1. **Static:** `pnpm types` (tsc --noEmit) passes; `pnpm build` succeeds.
2. **Cold-start reproduction (the core fix):** load `build/` via chrome://extensions → Load Unpacked. Open the popup once to confirm it works, then **wait >30s** (or confirm the service worker shows as stopped on the chrome://extensions card) and re-open the popup **without clicking Refresh**. Expected: spinner briefly, then PRs appear. Before the fix this exact sequence renders the fake-empty list.
3. **Service worker logs:** click "service worker" on the chrome://extensions card to open its DevTools; verify `[BACKGROUND] loaded settings, user: <login>` appears before the fetch log lines when a cold-start message arrives.
4. **Username persistence:** after one successful open, fully stop the service worker and open the popup again; verify no `GET /user` request in the SW network tab (username came from `chrome.storage.local`) and data still loads.
5. **Error surfacing:** temporarily corrupt the token in Settings; open the popover. Expected: the `error` state ("Could not resolve GitHub username…") instead of a silent empty list; badge clears on next valid token.
6. **Regressions:** manual Refresh button still works; Review Requests ↔ My Open PRs toggle still refetches; no-token and no-repos states still render their settings links; badge count updates on review-mode fetches.
7. **Concurrency:** open the popup immediately after changing settings in the options page (triggers `storage.onChanged` + popup fetch simultaneously); no empty result, no unhandled rejection.

## 6. Risks and open questions

- **UX change — errors instead of silent empty:** today an unresolvable username shows a plausible-looking empty list; after this change it shows an explicit error. That's almost certainly the desired behavior, but it's a visible change worth a screenshot review by the owner.
- **Cache-key contract with #8:** this plan assumes #8 writes `chrome.storage.local` under keys like `cachedPullRequests` / `cachedMyPullRequests` (with `fetchedAt`) and that the background (not the popover) owns cache writes. If #8's plan chooses a different shape, the popover mount-effect and the Step 2 "seam" comment need to be reconciled — the two issues should land with a shared contract or be implemented together.
- **Response-shape change:** adding a top-level `error` field is backwards-compatible (the popover currently ignores unknown fields), but any other consumer of these messages (none exist today besides the popover) would need review.
- **`storage.onChanged` invalidation window:** between a settings change and the next `getSettings()`, a concurrent in-flight fetch can still use the previous settings — acceptable (self-corrects on the next request/alarm tick).
- **Username staleness:** the persisted `username` is only cleared when the token *changes*; a same-token username rename on GitHub won't be picked up until the token changes. Acceptable for now; a TTL on the cached username is a possible follow-up.
- **Not addressed (out of scope):** the 5-minute alarm refresh only updates the badge; feeding it into the #8 cache is #8's plan, not this one.
