---
"chrome-extension": patch
---

Cached fetched review data in `chrome.storage.local` so the popup renders the last-known PR list immediately on open instead of showing a spinner, with an "Updated Xm ago" label. The cache is refreshed by every fetch (popup open, refresh button, and the 5-minute badge poll) and invalidated when the token or repos setting changes.
