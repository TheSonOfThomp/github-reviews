import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
} from "./fetchPullRequests";
import { writeCache, clearCache } from "./reviewCache";

const ALARM_NAME = "poll-pull-requests";
const POLL_INTERVAL_MINUTES = 5;
const BADGE_COLOR = "#ffffff"; // --fgColor-onEmphasis
const BADGE_BG_COLOR = "#1f883d"; //--bgColor-open-emphasis

let githubToken: string = "";
let repos: string[] = [];
let username: string = "";

function updateBadge(count: number) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeTextColor({ color: BADGE_COLOR });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
}

// Cache writes are gated on settings being loaded: a cold-started service worker
// can receive a message before the top-level chrome.storage.sync.get finishes,
// and an empty-settings fetch result must not overwrite a good cache.
// DEMO mode is always eligible (same bypass as the badge-refresh guard).
const settingsLoaded = () =>
  process.env.DEMO_MODE === "true" || (!!githubToken && !!repos.length && !!username);

async function refreshPullRequests() {
  // In DEMO mode the fetchers fall back to built-in repos/username, so the
  // settings guard is skipped and the badge still shows a demo count.
  // NOTE: keep the negated flag check as `!== "true"` — a bare
  // `!process.env.DEMO_MODE` folds to constant false in production builds
  // and would delete this guard from prod bundles.
  if (process.env.DEMO_MODE !== "true" && (!githubToken || !repos.length || !username)) {
    updateBadge(0);
    return;
  }

  try {
    const { prs, errors } = await fetchOpenPullRequests(githubToken, repos, username);
    updateBadge(prs.length);
    writeCache("review", { prs, errors, repos, fetchedAt: Date.now() });
  } catch (e) {
    console.error("[BACKGROUND] badge refresh failed:", e);
  }
}

chrome.storage.sync.get({ githubToken: "", repos: [] }, async (stored) => {
  githubToken = stored.githubToken;
  repos = stored.repos;
  if (githubToken) {
    username = await fetchAuthenticatedUser(githubToken).catch(() => "");
    console.log("[BACKGROUND] loaded settings, user:", username);
  } else {
    console.log("[BACKGROUND] loaded settings from storage");
  }
  refreshPullRequests();
});

chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshPullRequests();
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (changes.githubToken || changes.repos) {
    // Cached PRs belong to the old settings — invalidate
    clearCache();
  }
  if (changes.githubToken) {
    githubToken = changes.githubToken.newValue ?? "";
    username = githubToken
      ? await fetchAuthenticatedUser(githubToken).catch(() => "")
      : "";
    console.log("[BACKGROUND] token updated, user:", username);
  }
  if (changes.repos) {
    repos = changes.repos.newValue ?? [];
    console.log("[BACKGROUND] repos updated:", repos);
  }
  refreshPullRequests();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[BACKGROUND] received message:", message, sender);

  if (message.action === "GET_PULL_REQUESTS") {
    fetchOpenPullRequests(githubToken, repos, username).then(
      ({ prs, errors }) => {
        updateBadge(prs.length);
        if (settingsLoaded()) {
          writeCache("review", { prs, errors, repos, fetchedAt: Date.now() });
        }
        sendResponse({ action: "PULL_REQUESTS", payload: prs, errors });
      },
    );
    return true;
  }

  if (message.action === "GET_MY_PULL_REQUESTS") {
    fetchMyOpenPullRequests(githubToken, repos, username).then(
      ({ prs, errors }) => {
        if (settingsLoaded()) {
          writeCache("mine", { prs, errors, repos, fetchedAt: Date.now() });
        }
        sendResponse({ action: "MY_PULL_REQUESTS", payload: prs, errors });
      },
    );
    return true;
  }

  return true;
});
