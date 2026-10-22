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

  it("user-review-requested drops team-only PRs that review-requested includes (#27)", () => {
    const withTeams = search("review-requested").map((pr) => pr.id);
    const directOnly = search("user-review-requested").map((pr) => pr.id);

    expect(directOnly.length).toBeGreaterThan(0);
    expect(directOnly.length).toBeLessThan(withTeams.length);
    expect(withTeams).toEqual(expect.arrayContaining(directOnly));
  });
});
