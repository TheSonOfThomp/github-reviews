import { describe, it, expect } from "vitest";
import { faker } from "@faker-js/faker";
import { waitTimeLabel, isPastSla, waitTimeTitle } from "../../src/popover/waitTime";
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

describe("waitTimeTitle", () => {
  it("flags the title only once past the SLA", () => {
    expect(waitTimeTitle(hoursAgo(1), 72, NOW)).toMatch(/^Open since .+/);
    expect(waitTimeTitle(hoursAgo(1), 72, NOW)).not.toContain("past SLA");
    expect(waitTimeTitle(hoursAgo(100), 72, NOW)).toContain("— past SLA");
  });
});

describe("demo data wait times", () => {
  it("spans both sides of the default 72h SLA (#37)", () => {
    faker.seed(7);
    faker.setDefaultRefDate("2026-01-01T00:00:00Z");
    // Ages count back from the refDate, so judge SLA from it too
    const now = Date.parse("2026-01-01T00:00:00Z");
    // The union is structurally guaranteed: the first generated PR is always
    // a review request with the 120h age, and every author PR (generated
    // next) lands on an under-SLA age — regardless of seed
    const review = demoSearchPullsForRepo("acme/widgets", "review-requested", "demo-user");
    const mine = demoSearchPullsForRepo("acme/widgets", "author", "demo-user");
    const union = [...new Map([...review, ...mine].map((pr) => [pr.id, pr])).values()];
    expect(union.length).toBeGreaterThan(0);
    expect(union.some((pr) => isPastSla(pr.created_at, 72, now))).toBe(true);
    expect(union.some((pr) => !isPastSla(pr.created_at, 72, now))).toBe(true);
    // And the review view always carries the past-SLA PR
    expect(review.some((pr) => isPastSla(pr.created_at, 72, now))).toBe(true);
  });
});
