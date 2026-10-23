// Wait-time display for PR rows (#26/#37). The clock starts at the *earlier*
// of the PR leaving draft and the review being requested (directly, or of
// the user's team); PR age is the fallback when no request event is known —
// own PRs, old cache entries, or a failed timeline lookup.
import { DEFAULT_WAIT_TIME_SLA_HOURS } from "../settings";

// Structural subset of PullRequest — no import needed, keeps this module pure
export interface WaitTimedPullRequest {
  created_at: string;
  review_requested_at?: string;
  ready_for_review_at?: string;
}

export type WaitBasisSource = "requested" | "ready" | "created";

export const waitBasis = (pr: WaitTimedPullRequest): { at: string; source: WaitBasisSource } => {
  if (pr.review_requested_at) {
    // A still-draft PR (or one never out of draft) has no ready time to compare
    if (
      pr.ready_for_review_at &&
      Date.parse(pr.ready_for_review_at) < Date.parse(pr.review_requested_at)
    ) {
      return { at: pr.ready_for_review_at, source: "ready" };
    }
    return { at: pr.review_requested_at, source: "requested" };
  }
  // lesser(ready, created) is always created — ready can only be later
  return { at: pr.created_at, source: "created" };
};

/** Compact relative age: `45m`, `3h`, `2d`, `5w`. */
export const waitTimeLabel = (since: string, now = Date.now()) => {
  const minutes = Math.max(1, Math.floor((now - new Date(since).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

/** At or past the SLA threshold (in hours) counts as overdue (#37). */
export const isPastSla = (since: string, slaHours: number = DEFAULT_WAIT_TIME_SLA_HOURS, now = Date.now()) =>
  now - new Date(since).getTime() >= slaHours * 3_600_000;

const SOURCE_LABEL: Record<WaitBasisSource, string> = {
  requested: "Review requested",
  ready: "Ready for review",
  created: "Open since",
};

/** Hover text: the basis event's exact timestamp, flagged once past the SLA. */
export const waitTimeTitle = (
  basis: { at: string; source: WaitBasisSource },
  slaHours: number = DEFAULT_WAIT_TIME_SLA_HOURS,
  now = Date.now()
) =>
  `${SOURCE_LABEL[basis.source]} ${new Date(basis.at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}${isPastSla(basis.at, slaHours, now) ? " — past SLA" : ""}`;
