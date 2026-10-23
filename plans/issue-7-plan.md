# Implementation Plan — Issue #7: Add DEBUG mode flag

> **DECISION (2026-09-16): SKIPPED for now by maintainer.** Do not implement. This plan is retained for possible future use.

> Issue: https://github.com/TheSonOfThomp/github-reviews/issues/7
> Status: PLANNED — not implemented. All file/line references verified against `main` @ `e5791bf`.

---

## 1. Issue summary (own words)

Add a build/runtime **DEBUG mode flag**. When the extension is run in DEBUG mode, every meaningful event the extension produces (settings loads, storage changes, scheduled polls, GitHub API requests/responses, message passing between popup and service worker, badge updates, UI state transitions) should be captured to a **local `.log` file** that the developer can open and read. In production builds the flag must be off, and the logging machinery should cost effectively nothing (dead-code eliminated).

Key constraint: this is a **Chrome MV3 extension**. The "app" runs in three isolated contexts — a service worker (`build/js/background.js`), the browser-action popup page (`build/js/popover.js`), and an options page (`build/js/options.js`). There is **no Node `fs` access anywhere**, and MV3 service workers have no DOM, so the file-writing strategy must work within Chrome's extension APIs.

---

## 2. Current behavior (verified code references)

### 2.1 The events that exist today

All current logging is ad-hoc `console.*` calls, which vanish when the popup or service worker is destroyed:

| Context | Event | Location |
|---|---|---|
| background | settings loaded from `chrome.storage.sync` (startup) | `src/background/background.ts:38–45` (`console.log` at :41, :43) |
| background | periodic poll fires (alarm `poll-pull-requests`, every 5 min) | `src/background/background.ts:46–52` (alarm created :46, handler :48–52) — **no log statement today** |
| background | badge refresh failure | `src/background/background.ts:32` (`console.error`) |
| background | token/repos updated via `chrome.storage.onChanged` | `src/background/background.ts:55–70` (`console.log` at :63, :67) |
| background | message received (`GET_PULL_REQUESTS` / `GET_MY_PULL_REQUESTS`) | `src/background/background.ts:73` (`console.log`) |
| background | per-repo GitHub API fetch, SSO/API errors, result counts | `src/background/fetchPullRequests.ts:50, 54, 61, 97, 101` |
| content script | external message received | `src/content/content.ts:2` (note: `content.js` is built by rollup but **not registered** under `content_scripts` in `build/manifest.json` — it is currently inert) |
| popup | mount, view-mode load/save, refresh click, state transitions | `src/popover/popover.tsx:24–80` — **no logging today** |
| options | settings load / debounced save / repo CRUD | `src/options/options.tsx` — no logging |

### 2.2 How a build-time flag can be wired

`rollup.config.mjs` already configures `@rollup/plugin-replace` (devDependency, lines 9–13):

```js
replace({
  'process.env.NODE_ENV': JSON.stringify('production'),
  preventAssignment: true,
}),
```

The same plugin can compile-time-replace a `process.env.DEBUG_MODE` token with `'true'`/`'false'`, letting each bundle contain or dead-code-eliminate the logging path. `@types/node` is installed, so `process.env` typechecks. There are 4 rollup bundle inputs (popover, content, background, options) sharing one `plugins` array — one edit covers all.

### 2.3 Where the manifest lives

`build/manifest.json` is **checked into git** (only `build/js` is gitignored; confirmed via `git ls-files build/`). It is edited directly and version-synced by `scripts/sync-manifest-version.mjs`. Current permissions: `["storage", "alarms"]` only — **no `downloads` permission**, which a "write a local file" flow requires.

### 2.4 MV3 file-writing constraints (investigated)

- Service worker: no DOM ⇒ **no `URL.createObjectURL`** in the background context; also no persistent state (killed after ~30s idle) ⇒ log buffer must be persisted (`chrome.storage.local`).
- `chrome.downloads.download` **can** accept a `blob:` URL, but only an extension **page** (popup/options) can create the blob. It accepts a caller-supplied `filename`, so `downloads.onDeterminingFilename` is unnecessary.
- There is no Chrome API to *append* to an existing local file; each download creates a new file.

---

## 3. Proposed design

### 3.1 Chosen approach — build-time flag + persisted ring buffer + popup-triggered `.log` download

**Flag (build-time):**
- `DEBUG_MODE` is resolved in `rollup.config.mjs` from the environment (`process.env.DEBUG_MODE` or presence of a `.env.debug` marker — see step 1) and injected via the existing `@rollup/plugin-replace` as `process.env.DEBUG_MODE: JSON.stringify('true'|'false')`.
- New pnpm scripts: `"build:debug": "DEBUG_MODE=true pnpm build"` and `"watch:debug": "DEBUG_MODE=true pnpm watch"`. Normal `pnpm build` stays production (flag replaced with `'false'`, tree-shaken away).

**Logging core (new shared module `src/shared/debug.ts`, bundled into each context):**
- `export const DEBUG: boolean = process.env.DEBUG_MODE === 'true';`
- `debugLog(category: string, event: string, data?: unknown)` — formats one entry as `<ISO timestamp>\t<category>\t<event>\t<JSON data|->` and (a) mirrors to `console.log`, (b) appends to a per-context in-memory buffer, (c) debounced-flushes (≈500ms) that buffer to **`chrome.storage.local`** under a per-context key: `debugLog:background`, `debugLog:popup`, `debugLog:options`. Per-context keys avoid last-write-wins races between simultaneously-live contexts writing one shared key.
- Buffer capped (e.g. 300 entries/context) so `storage.local` (10 MB default quota, no sync limits apply) can never be exhausted; cap drops oldest entries.
- Everything inside `if (!DEBUG) return;` guards so production bundles tree-shake to nothing (replace plugin + rollup DCE).
- `export async function collectDebugLog(): Promise<string>` — reads all `debugLog:*` keys, merges, sorts by timestamp, renders final `.log` text.

**File export (popup UI, debug builds only):**
- In `src/popover/popover.tsx`, when `DEBUG` is compiled in, render a small "Debug" row in the footer next to the existing Settings link: a `Download log` link/button (Primer `IconButton` with `DownloadIcon` or a `Link` for consistency with the Settings link).
- Handler: `collectDebugLog()` → `new Blob([text], {type: 'text/plain'})` → `URL.createObjectURL(blob)` → `chrome.downloads.download({ url, filename: 'github-reviews/debug-<ISO-timestamp>.log' }, cb)` → `URL.revokeObjectURL` in callback. The popup stays open while the promise/callback resolves because the click originates there; if Chrome reports an error (e.g. download blocked), fall back to `saveAs: true` retry and surface the error in the footer.
- Add `"downloads"` to `permissions` in `build/manifest.json`. (The permission is harmless in production builds — nothing calls the API — or the manifest edit can be scripted; see risks/open questions.)

**Instrumentation:** route existing `console.*` calls through `debugLog` and add calls at currently-silent event points (alarm fire, badge update, popup mount/view-mode change/refresh/state transitions, fetch response sizes, message send/response in popup).

### 3.2 Alternatives considered (and why rejected)

1. **Continuous appends to a real file via File System Access API (`showSaveFilePicker` + persistent permission).** Closest to "log to a local `.log` file" literally, but the popup is short-lived (closes on any outside click), the service worker can't call it (no DOM/user gesture), and permission persistence across popup re-opens is unreliable. Rejected as primary mechanism.
2. **`chrome.downloads.download` directly from the service worker.** SW has no `URL.createObjectURL`; constructing a `data:text/plain,...` URL works in principle but is fragile for long logs (URL length limits) and some Chrome versions reject data URLs in the downloads API. Rejected.
3. **Log only to `chrome.storage.local`, view in a debug page (no file).** Simplest, but doesn't satisfy "log all events to a local `.log` file". Retained as the *storage layer* of the chosen design; the download step adds the file.
4. **Write to OPFS (Origin Private File System).** Persisted per-origin file storage, appendable from the SW. But extracting the file for a human still requires a page-context download step anyway, and OPFS adds complexity for no user-visible benefit over `storage.local`. Rejected.
5. **Runtime flag via `chrome.storage` instead of build-time.** Avoids rebuilds, but keeps debug code in shipped production bundles (store-review surface, payload bloat) and contradicts "running the app with this flag" being a developer build mode. Rejected; build-time chosen.
6. **`chrome.downloads.onDeterminingFilename` renaming.** Unnecessary because `download()` accepts `filename` directly. Rejected.

---

## 4. Step-by-step implementation steps

### Step 1 — Wire the flag in rollup + package.json

`rollup.config.mjs` (edit the existing `replace` block, lines ~9–13):

```js
const DEBUG_MODE = process.env.DEBUG_MODE === 'true' || process.env.DEBUG_MODE === '1';

const plugins = [
  // ...
  replace({
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.DEBUG_MODE': JSON.stringify(String(DEBUG_MODE)),
    preventAssignment: true,
  }),
];
```

`package.json` scripts:

```json
"build:debug": "cross-env DEBUG_MODE=true pnpm build",
"watch:debug": "cross-env DEBUG_MODE=true pnpm watch"
```

(`cross-env` not needed on macOS/Linux shells used here — plain `DEBUG_MODE=true pnpm build` also works; add `cross-env` as devDependency only if Windows support is desired. Also note the repo already has a `.env` file holding a token, but nothing loads `.env` into rollup — do **not** wire the flag to that file; keep it an explicit shell/CLI env var.)

### Step 2 — Create `src/shared/debug.ts`

```ts
/// Build-time DEBUG flag. Replaced by @rollup/plugin-replace; 'false' in
/// production builds so the logging below is dead-code eliminated.
export const DEBUG: boolean = process.env.DEBUG_MODE === 'true';

const MAX_ENTRIES_PER_CONTEXT = 300;
const FLUSH_DEBOUNCE_MS = 500;

export interface DebugEntry {
  t: string; // ISO timestamp
  c: string; // category, e.g. "BACKGROUND", "POPUP"
  e: string; // event name
  d?: string; // JSON-stringified data, "-" if none
}

const category = /* set per entry below */ '';

function bufferKey(cat: string) { return `debugLog:${cat}`; }

export function debugLog(cat: string, event: string, data?: unknown) {
  if (!DEBUG) return;
  const entry: DebugEntry = {
    t: new Date().toISOString(),
    c: cat, e: event,
    d: data === undefined ? '-' : JSON.stringify(data, replacer /* redact token */),
  };
  console.log(`[${cat}] ${event}`, data ?? '');
  appendToBuffer(cat, entry); // in-memory push + cap, then debounced flush
  scheduleFlush(cat); // chrome.storage.local.set({ [bufferKey(cat)]: buffer })
}

export async function collectDebugLog(): Promise<string> {
  if (!DEBUG) return '';
  const all = await chrome.storage.local.get(null); // or explicit debugLog:* keys
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith('debugLog:'))
    .flatMap(([, v]) => (v as DebugEntry[]))
    .sort((a, b) => a.t.localeCompare(b.t));
  return entries.map((e) => `${e.t}\t${e.c}\t${e.e}\t${e.d ?? '-'}`).join('\n') + '\n';
}

export function clearDebugLog() { /* chrome.storage.local.remove of debugLog:* keys */ }
```

Notes:
- A JSON **replacer must redact `githubToken`** before stringifying any settings-shaped object (never log the raw token; log masked `ghp_…abcd`).
- Flush from the popup is trivial; from the SW, `chrome.storage.local.set` from a non-DOM context is fine (no blob needed at this stage).
- `chrome.storage.local.get(null)` then filter is simplest; if the user has other local keys (e.g. issue #8 will add a review cache), filter with the `debugLog:` prefix as shown.

### Step 3 — Instrument the background service worker

`src/background/background.ts` (and `src/background/fetchPullRequests.ts`):
- Import `{ DEBUG, debugLog } from "../shared/debug"`.
- Replace the 6 existing `console.log/warn/error` calls (background.ts:32, 41, 43, 63, 67, 73; fetchPullRequests.ts:50, 54, 61, 97, 101) with `debugLog('BACKGROUND', ...)` — same labels, now persisted too.
- Add calls at currently-silent points:
  - alarm fired → `debugLog('BACKGROUND', 'alarm', { name: alarm.name })` (in the `onAlarm` listener, background.ts:48–52)
  - badge update → `debugLog('BACKGROUND', 'badge', { count })` (in `updateBadge`, background.ts:13–17)
  - message **response sent** → `debugLog('BACKGROUND', 'response', { action: 'PULL_REQUESTS', prs: prs.length, errors: errors.length })` in both handlers (background.ts:74–89)
  - fetch timing/durations optionally (`Date.now()` around `fetch`) — nice-to-have, mark as stretch.

### Step 4 — Instrument the popup

`src/popover/popover.tsx`:
- Import `{ DEBUG, debugLog } from "../shared/debug"`.
- Log: mount (`useEffect` at :24), view-mode read (:26), view-mode change (`handleViewModeChange`, :33), refresh click (`handleRefresh`, :47), message sent (in the data `useEffect`, :49), response received incl. counts (:59), and each terminal state (`setState` for `no-token`/`no-repos`/`error`).

### Step 5 — Debug footer + `.log` download in the popup

`src/popover/popover.tsx` footer (next to the Settings `Link` at ~line 100):

```tsx
const handleDownloadLog = async (e: React.MouseEvent) => {
  e.preventDefault();
  try {
    const text = await collectDebugLog();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    chrome.downloads.download(
      { url, filename: `github-reviews/debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log` },
      (downloadId) => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
      },
    );
  } catch (err) { console.error('[POPUP] log export failed', err); }
};

// in JSX, after the Settings link:
{DEBUG && (
  <Link href="#" onClick={handleDownloadLog} style={{ fontSize: 'var(--text-body-size-small)', paddingLeft: 12 }}>
    <DownloadIcon size={12} /> Debug log
  </Link>
)}
```

(`DownloadIcon` from `@primer/octicons-react`, already a dependency.)

### Step 6 — Manifest permission

`build/manifest.json` (checked-in file, edited directly): add `"downloads"` to `permissions`:

```json
"permissions": ["storage", "alarms", "downloads"]
```

### Step 7 — Changeset

Repo uses `@changesets/cli` (`.changeset/config.json` present, version synced by `scripts/sync-manifest-version.mjs`). Add a changeset file (`.changeset/<name>.md`, kind `minor`) describing the DEBUG build mode, e.g.:

```md
---
"github-reviews": minor
---
Add DEBUG build mode (`pnpm build:debug`) that records extension events and can export them as a local .log file from the popup.
```

### Step 8 — Optional (out of scope unless desired): options-page logging
Instrument `src/options/options.tsx` saves the same way (category `OPTIONS`). Low value for debugging the issue-#8/#9 popover flows; recommend deferring.

---

## 5. Testing / verification steps

1. **Typecheck:** `pnpm types` (`tsc --noEmit`) — must pass in both flag states (the `process.env.DEBUG_MODE` read typechecks via the installed `@types/node`).
2. **Production build stays clean:** `pnpm build`, then `grep -c "DEBUG" build/js/background.js` and confirm the debug module is absent/`DEBUG` is `false` (or fully tree-shaken); confirm no `"downloads"` API calls appear.
3. **Debug build:** `pnpm build:debug` (or `DEBUG_MODE=true pnpm build`), confirm `build/js/*.js` contain the logging code (`grep -c debugLog build/js/background.js` > 0).
4. **Manual verification in Chrome:**
   - `chrome://extensions` → Developer mode → "Load unpacked" → select `build/manifest.json` (existing README flow). Reload the extension after rebuild.
   - Set a token + repos in Options.
   - Open the popup: verify the "Debug log" footer link appears; open/close popup, click refresh, switch view modes.
   - Inspect SW console (`chrome://extensions` → service worker "inspect") — `chrome.alarms` fires every 5 min; wait or temporarily lower `POLL_INTERVAL_MINUTES` (background.ts:8) during manual testing to see alarm events.
   - Click "Debug log" → Chrome downloads `github-reviews/debug-….log` → open the file: expect interleaved `BACKGROUND` and `POPUP` entries, sorted by timestamp, with masked token.
   - Negative check: production build (`pnpm build`, reload) — no footer link, no `debugLog:*` keys written (verify via `chrome.storage.local.get(null)` in SW console), popup behaves as before.
5. **Regression:** normal user flows unaffected — badge count, refresh button, settings save (options page untouched), SSO error display in popup.

---

## 6. Risks and open questions

**Risks**
- **`downloads` permission in production builds.** Adding it to the always-shipped manifest widens permissions for end users (Chrome Web Store review flags new permissions; existing users see a "new permissions" notice on update). Mitigations: (a) accept it — the API is never called unless DEBUG code exists; (b) script a debug-only manifest variant (e.g. `scripts/sync-manifest-version.mjs`-style step that injects the permission when `DEBUG_MODE=true`). **Open question for maintainer — see below.**
- **Popup lifetime during download.** If the user clicks elsewhere mid-download, the popup (and its blob URL) dies. `chrome.downloads.download` should have already started; if not, the callback never fires and no file lands. Low impact for a debug tool; fallback `saveAs: true` mitigates.
- **Storage races.** Per-context keys (`debugLog:background` vs `debugLog:popup`) eliminate cross-context last-write-wins; within a context writes are single-threaded. Residual risk: multiple popup opens merge only at export time (acceptable).
- **`storage.local` quota** — capped buffer (300 entries ≈ a few hundred KB max) makes exhaustion impossible; no risk in practice.
- **Token leakage** — mitigated by mandatory replacer redaction; tests should manually inspect one exported log.
- **Service worker termination** — an in-memory entry not yet flushed (≤500 ms window) can be lost if the SW is killed mid-flush. Acceptable for debug tooling.

**Open questions for the maintainer (none block implementation of the chosen design)**
1. Should `downloads` ship in the production manifest, or should a debug build script produce a variant manifest? (Recommend: script the variant only if store-review friction matters; otherwise ship the permission.)
2. Is "log all events" intended to include the options page and the (currently unregistered) content script, or is background + popup sufficient? Plan instruments background + popup; content script is inert today (`build/manifest.json` has no `content_scripts` entry), so instrumenting it has no observable effect until it's registered.
3. Preferred log granularity: are fetch *timings* and full PR payload shapes wanted, or are counts sufficient? (Counts by default keeps the log small and PII-light.)
