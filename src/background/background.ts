import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
} from "./fetchPullRequests";
import { readCache, writeCache, clearCache } from "./reviewCache";
import { DEFAULT_INCLUDE_TEAM_REQUESTS } from "../settings";

const ALARM_NAME = "poll-pull-requests";
const POLL_INTERVAL_MINUTES = 5;
const SETTINGS_REFRESH_DEBOUNCE_MS = 500;
const BADGE_COLOR = "#ffffff"; // --fgColor-onEmphasis
const BADGE_BG_COLOR = "#1f883d"; //--bgColor-open-emphasis
const USERNAME_KEY = "githubUsername"; // under chrome.storage.local
const FRESH_CACHE_MS = POLL_INTERVAL_MINUTES * 60_000;

let githubToken: string = "";
let repos: string[] = [];
let username: string = "";
let includeTeamRequests: boolean = DEFAULT_INCLUDE_TEAM_REQUESTS;
let settingsGeneration = 0;
let fetchController = new AbortController();
let settingsRefreshTimer: ReturnType<typeof setTimeout> | undefined;

// Resolved once the module-scope settings above are fully loaded (storage
// reads only — never network). Anything that fetches with these values must
// await it: a cold-started service worker can otherwise serve messages with
// partially-loaded settings, producing 200-OK-but-empty responses (#9) and
// putting network round trips on the startup critical path that gates the
// first popup open after an extension reload (#16).
let settingsReadyResolve!: () => void;
const settingsReady = new Promise<void>((resolve) => (settingsReadyResolve = resolve));

type FetchContext = {
  generation: number;
  signal: AbortSignal;
  githubToken: string;
  repos: string[];
  username: string;
  includeTeamRequests: boolean;
};

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

const snapshotSettings = (): FetchContext => ({
  generation: settingsGeneration,
  signal: fetchController.signal,
  githubToken,
  repos: [...repos],
  username,
  includeTeamRequests,
});

const isCurrent = (context: FetchContext) =>
  context.generation === settingsGeneration && !context.signal.aborted;

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

function invalidateFetches() {
  settingsGeneration += 1;
  fetchController.abort();
  fetchController = new AbortController();
  if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = undefined;
  updateBadge(0);
  return settingsGeneration;
}

function scheduleSettingsRefresh(generation: number) {
  if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = setTimeout(() => {
    settingsRefreshTimer = undefined;
    if (generation === settingsGeneration) refreshPullRequests();
  }, SETTINGS_REFRESH_DEBOUNCE_MS);
}

async function refreshPullRequests() {
  await settingsReady;
  const context = snapshotSettings();
  // In DEMO mode the fetchers fall back to built-in repos/username, so the
  // settings guard is skipped and the badge still shows a demo count.
  // NOTE: keep the negated flag check as `!== "true"` — a bare
  // `!process.env.DEMO_MODE` folds to constant false in production builds
  // and would delete this guard from prod bundles.
  if (process.env.DEMO_MODE !== "true" && (!context.githubToken || !context.repos.length || !context.username)) {
    if (isCurrent(context)) updateBadge(0);
    return;
  }

  try {
    const { prs, errors } = await fetchOpenPullRequests(
      context.githubToken,
      context.repos,
      context.username,
      context.includeTeamRequests,
      context.signal
    );
    if (!isCurrent(context)) return;
    updateBadge(prs.length);
    writeCache("review", { prs, errors, repos: context.repos, fetchedAt: Date.now() });
  } catch (e) {
    if (!isAbortError(e)) console.error("[BACKGROUND] badge refresh failed:", e);
  }
}

// Startup: storage reads resolve settingsReady in milliseconds; the username
// comes from cache (its /user round trip must not sit on the startup critical
// path — #16). The only network here is the badge refresh, which is skipped
// when the cache is fresh (the 5-minute alarm owns ongoing refreshes).
const startSettings = async () => {
  const stored = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.sync.get(
      { githubToken: "", repos: [], includeTeamRequests: DEFAULT_INCLUDE_TEAM_REQUESTS },
      resolve
    )
  );
  githubToken = stored.githubToken as string;
  repos = stored.repos as string[];
  includeTeamRequests = stored.includeTeamRequests as boolean;
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
  if (alarm.name === ALARM_NAME) refreshPullRequests();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  await settingsReady;
  if (!changes.githubToken && !changes.repos && !changes.includeTeamRequests) return;

  const generation = invalidateFetches();
  clearCache();

  if (changes.githubToken) {
    githubToken = changes.githubToken.newValue ?? "";
    username = "";
  }
  if (changes.repos) {
    repos = changes.repos.newValue ?? [];
    console.log("[BACKGROUND] repos updated:", repos);
  }
  if (changes.includeTeamRequests) {
    // A removed key falls back to the default (on), not to false
    includeTeamRequests = changes.includeTeamRequests.newValue ?? DEFAULT_INCLUDE_TEAM_REQUESTS;
    console.log("[BACKGROUND] includeTeamRequests updated:", includeTeamRequests);
  }
  if (changes.githubToken) {
    const token = githubToken;
    const resolvedUsername = token
      ? await fetchAuthenticatedUser(token, fetchController.signal).catch(() => "")
      : "";
    if (generation !== settingsGeneration) return;
    username = resolvedUsername;
    saveCachedUsername(username);
    console.log("[BACKGROUND] token updated, user:", username);
  }
  scheduleSettingsRefresh(generation);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[BACKGROUND] received message:", message, sender);

  if (message.action === "GET_PULL_REQUESTS") {
    settingsReady.then(async () => {
      const context = snapshotSettings();
      const { prs, errors } = await fetchOpenPullRequests(
        context.githubToken,
        context.repos,
        context.username,
        context.includeTeamRequests,
        context.signal
      );
      if (!isCurrent(context)) return;
      updateBadge(prs.length);
      writeCache("review", { prs, errors, repos: context.repos, fetchedAt: Date.now() });
      sendResponse({ action: "PULL_REQUESTS", payload: prs, errors });
    }).catch((error) => {
      if (!isAbortError(error)) console.error("[BACKGROUND] pull-request request failed:", error);
    });
    return true;
  }

  if (message.action === "GET_MY_PULL_REQUESTS") {
    settingsReady.then(async () => {
      const context = snapshotSettings();
      const { prs, errors } = await fetchMyOpenPullRequests(
        context.githubToken,
        context.repos,
        context.username,
        context.signal
      );
      if (!isCurrent(context)) return;
      writeCache("mine", { prs, errors, repos: context.repos, fetchedAt: Date.now() });
      sendResponse({ action: "MY_PULL_REQUESTS", payload: prs, errors });
    }).catch((error) => {
      if (!isAbortError(error)) console.error("[BACKGROUND] my-pull-request request failed:", error);
    });
    return true;
  }

  return true;
});
