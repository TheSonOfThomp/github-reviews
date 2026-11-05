import { describe, expect, it } from "vitest";
import type { PullRequest } from "../../src/background/fetchPullRequests";
import { sortPullRequests } from "../../src/popover/sortPullRequests";

type SortablePR = Pick<PullRequest, "draft" | "created_at" | "review_requested_at" | "ready_for_review_at" | "review_status">;
const pr = (id: number, fields: Partial<SortablePR> = {}) => ({
  id,
  draft: false,
  created_at: "2026-01-01T00:00:00Z",
  ...fields,
}) as PullRequest;

describe("sortPullRequests", () => {
  it("sorts review requests by longest elapsed wait, with drafts last regardless of age", () => {
    const newest = pr(1, { review_requested_at: "2026-01-05T00:00:00Z" });
    const oldest = pr(2, { ready_for_review_at: "2026-01-02T00:00:00Z", review_requested_at: "2026-01-04T00:00:00Z" });
    const draft = pr(3, { draft: true, review_requested_at: "2026-01-01T00:00:00Z" });
    const fallback = pr(4); // old cache without enrichment uses the PR's age
    const input = [newest, draft, oldest, fallback];
    expect(sortPullRequests(input, "review").map((item) => item.id)).toEqual([4, 2, 1, 3]);
    expect(input.map((item) => item.id)).toEqual([1, 3, 2, 4]);
  });

  it("puts approved and changes requested first, then comments, open, and drafts", () => {
    const input = [
      pr(1, { review_status: "awaiting-review" }),
      pr(2, { review_status: "comments-pending" }),
      pr(3, { review_status: "changes-requested", draft: true }),
      pr(4, { review_status: "approved" }),
      pr(5, { review_status: "changes-requested" }),
      pr(6), // enrichment missing: treat as open
      pr(7, { review_status: "approved" }),
    ];
    expect(sortPullRequests(input, "mine").map((item) => item.id)).toEqual([4, 5, 7, 2, 1, 6, 3]);
  });
});
