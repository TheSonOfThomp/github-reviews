# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Chrome extension (Manifest V3, checked in at `build/manifest.json`) that surfaces GitHub pull requests awaiting your review. React 18 + `@primer/react` UI, built with Rollup + pnpm.

- `src/background/` — MV3 service worker: GitHub fetching (`fetchPullRequests.ts`), demo data (`demoData.ts`), review cache (`reviewCache.ts`), badge/alarms wiring (`background.ts`)
- `src/popover/` — the toolbar action popup (not a page-injected popover despite the name)
- `src/options/` — settings page (GitHub token, repos)
- `src/content/` — currently an inert stub

## Commands

- `pnpm build` / `pnpm watch` — production build
- `pnpm build:demo` / `pnpm watch:demo` — DEMO build (fake Faker.js data, no GitHub API; see PR #12)
- `pnpm types` — typecheck (clean; the former pre-existing `options.tsx:206` implicit-any was fixed to let CI pass)

## Build-flag safety

`process.env.DEMO_MODE` is injected as a string literal by `@rollup/plugin-replace`. Negated checks **must** use `process.env.DEMO_MODE !== "true"` — a bare `!process.env.DEMO_MODE` folds to constant-false in production builds and silently dead-code-eliminates production guards.

## Verifying changes (agent-runnable)

- `pnpm types` — no new errors
- `pnpm test:unit` — vitest suite with a mocked `chrome` global (`test/mocks/chrome.ts`) + mocked `fetch`; covers `fetchPullRequests` (SSO header parsing, review/mine filtering, error buckets), `reviewCache`, and the background wiring (message handling, the `settingsLoaded()` cold-start cache gate, settings-change invalidation, alarms/badge)
- `pnpm test:e2e` — Playwright suite in `e2e/`; self-contained (builds the extension via global setup, needs `pnpm exec playwright install chromium` once). Covers the popup flows against a stubbed GitHub API: no-token guard, render + cache write, stale-while-revalidate, cache invalidation on settings change, view toggle, SSO error path
- `pnpm test` — both
- `pnpm build` — then grep the bundles: DEMO artifacts (`faker`, `pravatar`, `demo-user`) must be 0 in production; `no-token`/`no-repos` guards must survive (2 occurrences each in `popover.js`); `prCache` present in `background.js` + `popover.js`
- `pnpm build:demo` — then grep: `api.github.com` refs in `background.js` must be 0; restore with `pnpm build` afterward

## Automated browser testing (Playwright) — how it works

The E2E suite (`e2e/`) drives the real built extension headlessly; no human, no DevTools, no GitHub credentials. Key mechanics, in case you need to extend it:

- **Loading**: `chromium.launchPersistentContext` with `--disable-extensions-except` + `--load-extension`, and **`channel: "chromium"`** — Playwright's default headless *shell* cannot load extensions; this channel selects full Chromium in the new headless mode.
- **Popup**: opened as a regular tab at `chrome-extension://<id>/index.html` (the toolbar action itself is not scriptable — this is the sanctioned workaround).
- **Deterministic ID**: `build/manifest.json` carries a committed `key` (public half of a dev-only keypair), so the unpacked extension ID is `lgmeobbcpmgdpheclekekjkcjehpecgo` on every machine. The publish workflows strip this key before zipping — keep that step if you touch them.
- **GitHub API stubbing**: the browser is launched with `--host-resolver-rules` mapping `api.github.com` (and `i.pravatar.cc`, for demo avatars) to the in-process HTTPS stub in `e2e/stub/server.ts` (self-signed cert checked in beside it). The stub serves data from the DEMO-mode generator (`demoRawPullsForRepo`), re-seeding faker per response so each fetch returns different-but-deterministic data — tests tell fetches apart by content and use the `prCache` storage as the source of truth for assertions.
- **Viewport + themes**: contexts launch at 360×600 (the popover's real chrome) and run twice via the `light`/`dark` Playwright projects — the context fixture maps the project name to `prefers-color-scheme`, which Primer's `colorMode="auto"` follows.
- **Service worker access**: `context.serviceWorkers()` (or `waitForEvent("serviceworker")`) yields the extension SW; `sw.evaluate()` runs inside it — read/write `chrome.storage` from there, and `sw.on("console")` captures its logs. In the specs, storage helpers run via `page.evaluate` on the popup page instead, because pages outlive an idle-stopped SW.
- **PR screenshot comments**: every test's popup screenshot is captured, but only tests that call `commentScreenshot()` (a `comment-screenshot` annotation) are published to the PR comment by CI — selection is read from the JSON reporter output via `e2e/scripts/flagged-screenshots.mjs`.
- Set `E2E_SKIP_BUILD=1` to reuse an existing `build/` while iterating.

### Still human-only

- Loading the extension into your real browser profile (agent browsers can't load unpacked extensions into a managed profile)
- `chrome://` pages (extensions manager, storage inspector)
- Chrome Web Store publish flows (workflows handle it, but verifying the store listing is manual)

For background on why this setup exists: issue #14.

## Conventions

- Changesets: repo uses `.changeset/`; the package is pre-1.0, so feature releases are `patch`, not `minor`
- Chrome manifest `version` accepts 1–4 dot-separated integers only — no prerelease tags (`0.2.1-alpha.0` is invalid); `scripts/sync-manifest-version.mjs` copies `package.json` → `build/manifest.json` verbatim
- Issues #6–#9 have implementation plans in `plans/`; #7 is skipped, #9 is deferred until #8 lands
