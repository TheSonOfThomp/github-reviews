---
"chrome-extension": patch
---

The popup now paints instantly on first open: a static HTML skeleton spinner shows while the JS bundle parses (previously the popup stayed blank because the loading spinner only existed inside React), and bundles are minified with terser (popover.js 2.1MB → 1.75MB). The popup is now a fixed 320px wide with left-aligned content, matching the pre-JS skeleton so the window never resizes.
