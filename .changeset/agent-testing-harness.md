---
"chrome-extension": patch
---

Add automated testing: vitest unit suite (mocked `chrome` global + `fetch`) and a self-contained Playwright E2E suite that loads the built extension headlessly against a stubbed GitHub API. Commit a manifest `key` so the unpacked extension ID is deterministic (`lgmeobbcpmgdpheclekekjkcjehpecgo`); publish workflows strip it before zipping. Adds a CI workflow.
