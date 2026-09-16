---
"chrome-extension": patch
---

The settings page and the popover footer now show the extension version and the short commit hash of the build (e.g. "v0.2.0 · 8eddfc2") as debugging info. The version is read from the manifest at runtime; the commit hash is injected at build time by Rollup (`unknown` when building without git).
