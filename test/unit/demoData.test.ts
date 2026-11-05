import { describe, it, expect } from "vitest";
import { faker } from "@faker-js/faker";
import { demoSearchPullsForRepo, type DemoSearchQualifier } from "../../src/background/demoData";

const search = (qualifier: DemoSearchQualifier) => {
  faker.seed(7);
  faker.setDefaultRefDate("2026-01-01T00:00:00Z");
  return demoSearchPullsForRepo("acme/widgets", qualifier, "demo-user");
};

describe("demoSearchPullsForRepo", () => {
  it("returns identical results for the same seed, regardless of earlier calls", () => {
    expect(search("review-requested")).toEqual(search("review-requested"));
  });

  it("makes every status tier visible and keeps an approved draft for the author screenshot", () => {
    const prs = search("author");
    expect(prs.map((pr) => [pr.review_status, pr.draft])).toEqual([
      ["awaiting-review", false],
      ["comments-pending", false],
      ["approved", false],
      ["changes-requested", false],
      ["approved", true],
    ]);
    expect(prs.map((pr) => pr.title)).toEqual([
      "Awaiting review — ready for feedback",
      "Comments pending — follow up",
      "Approved — ready to merge",
      "Changes requested — update needed",
      "Draft — approved but still in progress",
    ]);
  });

  it("includes an older draft alongside ready review requests", () => {
    const prs = search("user-review-requested");
    expect(prs.length).toBeGreaterThanOrEqual(3);
    expect(prs[0].draft).toBe(true);
    expect(prs[0].title).toBe("Draft — design in progress");
    expect(prs.slice(1).every((pr) => !pr.draft)).toBe(true);
    expect(Date.parse(prs[0].created_at)).toBeLessThan(Date.parse(prs[1].created_at));
  });

  it("user-review-requested drops team-only PRs that review-requested includes (#27)", () => {
    const withTeams = search("review-requested").map((pr) => pr.id);
    const directOnly = search("user-review-requested").map((pr) => pr.id);

    expect(directOnly.length).toBeGreaterThan(0);
    expect(directOnly.length).toBeLessThan(withTeams.length);
    expect(withTeams).toEqual(expect.arrayContaining(directOnly));
  });
});
