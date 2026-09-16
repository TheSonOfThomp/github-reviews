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
- `pnpm types` — typecheck (a pre-existing error exists in `src/options/options.tsx:206`; ignore it, don't fix it incidentally)

## Build-flag safety

`process.env.DEMO_MODE` is injected as a string literal by `@rollup/plugin-replace`. Negated checks **must** use `process.env.DEMO_MODE !== "true"` — a bare `!process.env.DEMO_MODE` folds to constant-false in production builds and silently dead-code-eliminates production guards.

## Verifying changes (agent-runnable)

- `pnpm types` — no new errors
- `pnpm build` — then grep the bundles: DEMO artifacts (`faker`, `pravatar`, `demo-user`) must be 0 in production; `no-token`/`no-repos` guards must survive (2 occurrences each in `popover.js`); `prCache` present in `background.js` + `popover.js`
- `pnpm build:demo` — then grep: `api.github.com` refs in `background.js` must be 0; restore with `pnpm build` afterward

## Chrome testing limitations — read this before trying to "just test it"

**We cannot easily use the Chrome browser to debug or test this extension from an agent session.** Verified limitations:

- An agent's managed/automated browser cannot load unpacked extensions. Loading requires launching a *separate* Chrome instance with `--load-extension=<repo>/build` and a throwaway `--user-data-dir` profile:
  ```
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir=$(mktemp -d) --no-first-run \
    --load-extension="$(pwd)/build"
  ```
- The toolbar popup cannot be opened programmatically (no scriptable click on the action icon). Workaround: pass `chrome-extension://<id>/index.html` as a startup tab — it renders the popup UI in a normal tab. The unpacked extension ID is deterministic from the build path (SHA-256 of the absolute path, hex digits mapped a–p).
- The extension's service worker (its console, network, `chrome.storage` contents) is not reachable from agent tooling — a human must open DevTools at `chrome://extensions` → *service worker* / *Inspect views*.
- `chrome://` pages are not accessible to automation.

**Therefore:** behavioral verification (cache hits, badge, SSO paths, storage invalidation) is human-only for now. Agents should do the static bundle checks above, optionally launch a headed Chrome with the extension for a human, and say clearly what remains manually unverified.

**Investigating better options (automated E2E, CDP access, unit-testable seams): see issue #14.**

## Conventions

- Changesets: repo uses `.changeset/`; the package is pre-1.0, so feature releases are `patch`, not `minor`
- Chrome manifest `version` accepts 1–4 dot-separated integers only — no prerelease tags (`0.2.1-alpha.0` is invalid); `scripts/sync-manifest-version.mjs` copies `package.json` → `build/manifest.json` verbatim
- Issues #6–#9 have implementation plans in `plans/`; #7 is skipped, #9 is deferred until #8 lands
