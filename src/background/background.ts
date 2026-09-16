import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
} from "./fetchPullRequests";
import { readCache, writeCache, clearCache } from "./reviewCache";

const ALARM_NAME = "poll-pull-requests";
const POLL_INTERVAL_MINUTES = 5;
const BADGE_COLOR = "#ffffff"; // --fgColor-onEmphasis
const BADGE_BG_COLOR = "#1f883d"; //--bgColor-open-emphasis
const USERNAME_KEY = "githubUsername"; // under chrome.storage.local
const FRESH_CACHE_MS = POLL_INTERVAL_MINUTES * 60_000;

let githubToken: string = "";
let repos: string[] = [];
let username: string = "";

// Resolved once the module-scope settings above are fully loaded (storage
// reads only — never network). Anything that fetches with these values must
// await it: a cold-started service worker can otherwise serve messages with
// partially-loaded settings, producing 200-OK-but-empty responses (#9) and
// putting network round trips on the startup critical path that gates the
// first popup open after an extension reload (#16).
let settingsReadyResolve!: () => void;
const settingsReady = new Promise<void>((resolve) => (settingsReadyResolve = resolve));

function updateBadge(count: number) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  chrome.action.setBadgeTextColor({ color: BADGE_COLOR });
  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_COLOR });
}

const loadCachedUsername = () =>
  new Promise<string>((resolve) =>
    chrome.storage.local.get({ [USERNAME_KEY]: "" }, (stored) => resolve(stored[USERNAME_KEY] ?? ""))
  );

const saveCachedUsername = (name: string) =>
  new Promise<void>((resolve) => chrome.storage.local.set({ [USERNAME_KEY]: name }, () => resolve()));

async function refreshPullRequests() {
  await settingsReady;
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

// Startup: storage reads resolve settingsReady in milliseconds; the username
// comes from cache (its /user round trip must not sit on the startup critical
// path — #16). The only network here is the badge refresh, which is skipped
// when the cache is fresh (the 5-minute alarm owns ongoing refreshes).
const startSettings = async () => {
  const stored = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.sync.get({ githubToken: "", repos: [] }, resolve)
  );
  githubToken = stored.githubToken as string;
  repos = stored.repos as string[];
  username = await loadCachedUsername();
  if (githubToken && !username) {
    username = await fetchAuthenticatedUser(githubToken).catch(() => "");
    if (username) saveCachedUsername(username);
  }
  console.log("[BACKGROUND] loaded settings, user:", username);
  settingsReadyResolve();

  const cached = await readCache("review");
  if (cached && Date.now() - cached.fetchedAt < FRESH_CACHE_MS) {
    // Repopulate the badge (an extension reload clears it) from the fresh
    // cache instead of hitting the API — zero network on cold start.
    updateBadge(cached.prs.length);
    console.log("[BACKGROUND] startup badge refresh skipped, cache is fresh");
    return;
  }
  refreshPullRequests();
};

startSettings().catch((e) => {
  console.error("[BACKGROUND] settings load failed:", e);
  settingsReadyResolve(); // never leave message handlers waiting forever
});

chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshPullRequests();
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  await settingsReady;
  if (changes.githubToken || changes.repos) {
    // Cached PRs belong to the old settings — invalidate
    clearCache();
  }
  if (changes.githubToken) {
    githubToken = changes.githubToken.newValue ?? "";
    username = githubToken
      ? await fetchAuthenticatedUser(githubToken).catch(() => "")
      : "";
    saveCachedUsername(username);
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

  // Both handlers await settingsReady, so the fetchers never see partial
  // settings and cache writes are always safe (the old settingsLoaded()
  // write guard is unnecessary).
  if (message.action === "GET_PULL_REQUESTS") {
    settingsReady.then(() =>
      fetchOpenPullRequests(githubToken, repos, username).then(({ prs, errors }) => {
        updateBadge(prs.length);
        writeCache("review", { prs, errors, repos, fetchedAt: Date.now() });
        sendResponse({ action: "PULL_REQUESTS", payload: prs, errors });
      })
    );
    return true;
  }

  if (message.action === "GET_MY_PULL_REQUESTS") {
    settingsReady.then(() =>
      fetchMyOpenPullRequests(githubToken, repos, username).then(({ prs, errors }) => {
        writeCache("mine", { prs, errors, repos, fetchedAt: Date.now() });
        sendResponse({ action: "MY_PULL_REQUESTS", payload: prs, errors });
      })
    );
    return true;
  }

  return true;
});
