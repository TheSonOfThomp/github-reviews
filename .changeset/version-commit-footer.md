---
"chrome-extension": patch
---

The settings page now shows the extension version and the short commit hash of the build (e.g. "GitHub Reviews v0.2.0 · 8eddfc2") in a muted footer, for easier debugging. The version is read from the manifest at runtime; the commit hash is injected at build time by Rollup (`unknown` when building without git).
