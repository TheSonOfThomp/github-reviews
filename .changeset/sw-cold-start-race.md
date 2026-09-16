---
"chrome-extension": patch
---

Fix the popover showing empty PR data (and the slow first open after an extension reload) on service-worker cold start. The popup's data requests were served before the service worker finished loading its settings, so fetches ran with an empty username and returned 200-OK-but-empty results that rendered as "No pull requests awaiting your review" until a manual refresh. Message handlers now await a `settingsReady` promise that resolves from storage reads only, the GitHub username is persisted in `chrome.storage.local` so cold starts make no `/user` round trip, and the startup badge refresh is skipped when the review cache is fresh — removing all network work from the service-worker startup critical path that gated the first popup open after a reload.
