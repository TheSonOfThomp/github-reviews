---
"chrome-extension": minor
---

Show how long each PR has been awaiting review: a compact wait time at the end of each popover row that starts at the earlier of the PR leaving draft and the review being requested (directly, or of your team) — resolved in the same batched GraphQL lookup the CI icons use — with PR age as the fallback. Exact timestamp on hover, a Settings toggle to hide it, and a review SLA (hours) that turns overdue wait times red. Resolves #26, resolves #37.
