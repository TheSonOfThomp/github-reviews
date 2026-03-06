import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
} from "./fetchPullRequests";

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

async function refreshPullRequests() {
  if (!githubToken || !repos.length || !username) {
    updateBadge(0);
    return;
  }

  try {
    const { prs } = await fetchOpenPullRequests(githubToken, repos, username);
    updateBadge(prs.length);
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
        sendResponse({ action: "PULL_REQUESTS", payload: prs, errors });
      },
    );
    return true;
  }

  return true;
});
