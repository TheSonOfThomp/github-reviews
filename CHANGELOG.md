# chrome-extension

## 0.3.0

### Minor Changes

- 1b25b95: Fetch pull requests through the GitHub Search API so PRs in large repos (1,500+ open PRs) and review requests sent to your teams now show up. Failed fetches, inaccessible repos, and rate limits are now reported for each repo instead of showing an empty list (#10).

### Patch Changes

- 8c25256: Hide the commit hash in the popup and settings footers for builds from `main`; only builds from other branches show it.

## 0.2.1

### Patch Changes

- 878cf91: Add automated testing: vitest unit suite (mocked `chrome` global + `fetch`) and a self-contained Playwright E2E suite that loads the built extension headlessly against a stubbed GitHub API. Commit a manifest `key` so the unpacked extension ID is deterministic (`lgmeobbcpmgdpheclekekjkcjehpecgo`); publish workflows strip it before zipping. Adds a CI workflow.
- 4b39296: Added a DEMO build mode (`pnpm build:demo`) that renders deterministic Faker.js data with pravatar.cc placeholder avatars instead of hitting the GitHub API — no token or repos required. Faker and demo data are tree-shaken out of normal production builds.
- 381a58b: The popup now paints instantly on first open: a static HTML skeleton spinner shows while the JS bundle parses (previously the popup stayed blank because the loading spinner only existed inside React), and bundles are minified with terser (popover.js 2.1MB → 1.75MB). The popup is now a fixed 360px wide with left-aligned content and no white margin around the window edge (browser-default body margin reset; skeleton matches the app's light/dark color scheme), so the window never resizes on mount.
- 8eddfc2: Cached fetched review data in `chrome.storage.local` so the popup renders the last-known PR list immediately on open instead of showing a spinner, with an "Updated Xm ago" label. The cache is refreshed by every fetch (popup open, refresh button, and the 5-minute badge poll) and invalidated when the token or repos setting changes.
- 00fd303: Fix the popover showing empty PR data (and the slow first open after an extension reload) on service-worker cold start. The popup's data requests were served before the service worker finished loading its settings, so fetches ran with an empty username and returned 200-OK-but-empty results that rendered as "No pull requests awaiting your review" until a manual refresh. Message handlers now await a `settingsReady` promise that resolves from storage reads only, the GitHub username is persisted in `chrome.storage.local` so cold starts make no `/user` round trip, and the startup badge refresh is skipped when the review cache is fresh — removing all network work from the service-worker startup critical path that gated the first popup open after a reload.
- f90ed96: The settings page and the popover footer now show the extension version and the short commit hash of the build (e.g. "v0.2.0 · 8eddfc2") as debugging info. The version is read from the manifest at runtime; the commit hash is injected at build time by Rollup (`unknown` when building without git).
