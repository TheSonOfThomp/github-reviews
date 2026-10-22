---
"chrome-extension": patch
---

Show CI status on PRs in both views (#32). Each PR row now shows a status icon (passing/failing/pending) linked to the PR's checks page, populated by a single batched GraphQL `nodes(ids:)` query per refresh (chunked at 100 IDs) using the head commit's `statusCheckRollup.state`. A failed CI lookup never fails the refresh — PRs render without icons instead.
