import { describe, it, expect } from "vitest";
import { faker } from "@faker-js/faker";
import { waitBasis, waitTimeLabel, isPastSla, waitTimeTitle } from "../../src/popover/waitTime";
import { demoSearchPullsForRepo } from "../../src/background/demoData";

const NOW = new Date("2026-01-15T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("waitTimeLabel", () => {
  it("uses minutes, hours, days, then weeks at their boundaries", () => {
    expect(waitTimeLabel(hoursAgo(0), NOW)).toBe("1m"); // clamped, never 0m
    expect(waitTimeLabel(hoursAgo(59 / 60), NOW)).toBe("59m");
    expect(waitTimeLabel(hoursAgo(1), NOW)).toBe("1h");
    expect(waitTimeLabel(hoursAgo(23), NOW)).toBe("23h");
    expect(waitTimeLabel(hoursAgo(24), NOW)).toBe("1d");
    expect(waitTimeLabel(hoursAgo(13 * 24), NOW)).toBe("13d");
    expect(waitTimeLabel(hoursAgo(14 * 24), NOW)).toBe("2w");
  });
});

describe("isPastSla", () => {
  it("counts at and after the threshold as past, just before as not", () => {
    expect(isPastSla(hoursAgo(71), 72, NOW)).toBe(false);
    expect(isPastSla(hoursAgo(72), 72, NOW)).toBe(true);
    expect(isPastSla(hoursAgo(300), 72, NOW)).toBe(true);
  });
});

describe("waitBasis", () => {
  const pr = (fields: { created_at: string; review_requested_at?: string; ready_for_review_at?: string }) => fields;

  it("starts the clock at the earlier of ready-for-review and the request", () => {
    // Ready after the request → the request time wins
    expect(
      waitBasis(pr({ created_at: hoursAgo(100), review_requested_at: hoursAgo(90), ready_for_review_at: hoursAgo(50) }))
    ).toEqual({ at: hoursAgo(90), source: "requested" });
    // Ready before the request → the ready time wins
    expect(
      waitBasis(pr({ created_at: hoursAgo(100), review_requested_at: hoursAgo(30), ready_for_review_at: hoursAgo(80) }))
    ).toEqual({ at: hoursAgo(80), source: "ready" });
  });

  it("uses the request time alone when the PR is still in draft (no ready time)", () => {
    expect(waitBasis(pr({ created_at: hoursAgo(100), review_requested_at: hoursAgo(20) }))).toEqual({
      at: hoursAgo(20),
      source: "requested",
    });
  });

  it("falls back to PR age when no request is known, ignoring ready time", () => {
    expect(waitBasis(pr({ created_at: hoursAgo(40), ready_for_review_at: hoursAgo(10) }))).toEqual({
      at: hoursAgo(40),
      source: "created",
    });
  });
});

describe("waitTimeTitle", () => {
  it("labels the basis event and flags only past-SLA waits", () => {
    expect(waitTimeTitle({ at: hoursAgo(1), source: "requested" }, 72, NOW)).toMatch(/^Review requested .+/);
    expect(waitTimeTitle({ at: hoursAgo(1), source: "ready" }, 72, NOW)).toMatch(/^Ready for review .+/);
    expect(waitTimeTitle({ at: hoursAgo(1), source: "created" }, 72, NOW)).toMatch(/^Open since .+/);
    expect(waitTimeTitle({ at: hoursAgo(100), source: "requested" }, 72, NOW)).toContain("— past SLA");
    expect(waitTimeTitle({ at: hoursAgo(1), source: "requested" }, 72, NOW)).not.toContain("past SLA");
  });
});

describe("demo data wait times", () => {
  it("spans both sides of the default 72h SLA (#37)", () => {
    faker.seed(7);
    faker.setDefaultRefDate("2026-01-01T00:00:00Z");
    // Ages count back from the refDate, so judge SLA from it too
    const now = Date.parse("2026-01-01T00:00:00Z");
    const review = demoSearchPullsForRepo("acme/widgets", "review-requested", "demo-user");
    const mine = demoSearchPullsForRepo("acme/widgets", "author", "demo-user");
    const union = [...new Map([...review, ...mine].map((pr) => [pr.id, pr])).values()];
    const bases = union.map((pr) => waitBasis(pr).at);
    expect(union.length).toBeGreaterThan(0);
    expect(bases.some((at) => isPastSla(at, 72, now))).toBe(true);
    expect(bases.some((at) => !isPastSla(at, 72, now))).toBe(true);
    // And the review view always carries the past-SLA PR
    expect(review.some((pr) => isPastSla(waitBasis(pr).at, 72, now))).toBe(true);
  });

  it("gives review-view PRs a request time and leaves author-view PRs without one (#26)", () => {
    faker.seed(7);
    faker.setDefaultRefDate("2026-01-01T00:00:00Z");
    const review = demoSearchPullsForRepo("acme/widgets", "review-requested", "demo-user");
    const mine = demoSearchPullsForRepo("acme/widgets", "author", "demo-user");
    expect(review.every((pr) => pr.review_requested_at)).toBe(true);
    expect(mine.every((pr) => pr.review_requested_at === undefined)).toBe(true);
    // Draft PRs never left draft; non-draft PRs did
    expect(review.every((pr) => (pr.draft ? true : pr.ready_for_review_at !== undefined))).toBe(true);
  });
});
