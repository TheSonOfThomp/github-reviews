import type { PullRequest } from "../background/fetchPullRequests";
import { waitBasis } from "./waitTime";

const reviewPriority: Record<NonNullable<PullRequest["review_status"]>, number> = {
  approved: 0,
  "changes-requested": 0,
  "comments-pending": 1,
  "awaiting-review": 2,
};

export const sortPullRequests = (prs: PullRequest[], viewMode: "review" | "mine") =>
  [...prs].sort((a, b) => {
    if (a.draft !== b.draft) return Number(a.draft) - Number(b.draft);
    return viewMode === "review"
      ? Date.parse(waitBasis(a).at) - Date.parse(waitBasis(b).at)
      : (reviewPriority[a.review_status ?? "awaiting-review"] - reviewPriority[b.review_status ?? "awaiting-review"]);
  });
