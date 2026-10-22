// Wait-time display for PR rows (#26). Based on PR age (created_at), not the
// review-request timestamp — the Search API doesn't return the latter (#26
// open question), and created_at is already in the cache, so no extra fetch.
import { DEFAULT_WAIT_TIME_SLA_HOURS } from "../settings";

/** Compact relative age: `45m`, `3h`, `2d`, `5w`. */
export const waitTimeLabel = (createdAt: string, now = Date.now()) => {
  const minutes = Math.max(1, Math.floor((now - new Date(createdAt).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

/** At or past the SLA threshold (in hours) counts as overdue (#37). */
export const isPastSla = (createdAt: string, slaHours: number = DEFAULT_WAIT_TIME_SLA_HOURS, now = Date.now()) =>
  now - new Date(createdAt).getTime() >= slaHours * 3_600_000;

/** Hover text: exact open timestamp, flagged once past the SLA. */
export const waitTimeTitle = (
  createdAt: string,
  slaHours: number = DEFAULT_WAIT_TIME_SLA_HOURS,
  now = Date.now()
) =>
  `Open since ${new Date(createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}${isPastSla(createdAt, slaHours, now) ? " — past SLA" : ""}`;
