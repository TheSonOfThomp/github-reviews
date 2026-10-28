import {
  fetchAuthenticatedUser,
  fetchOpenPullRequests,
  fetchMyOpenPullRequests,
} from "./fetchPullRequests";
import { readCache, writeBothCaches, clearCache } from "./reviewCache";
import { DEFAULT_INCLUDE_TEAM_REQUESTS } from "../settings";

const BADGE_COLOR = "#ffffff"; // --fgColor-onEmphasis
const BADGE_BG_COLOR = "#1f883d"; //--bgColor-open-emphasis
const USERNAME_KEY = "githubUsername"; // under chrome.storage.local
const SETTINGS_REFRESH_DEBOUNCE_MS = 500;
const ALARM_NAME = "poll-pull-requests";
const POLL_INTERVAL_MINUTES = 5;

let githubToken: string = "";
let repos: string[] = [];
let username: string = "";
let includeTeamRequests: boolean = DEFAULT_INCLUDE_TEAM_REQUESTS;
let settingsGeneration = 0;
let fetchController = new AbortController();
type BothResults = {
  review: Awaited<ReturnType<typeof fetchOpenPullRequests>>;
  mine: Awaited<ReturnType<typeof fetchMyOpenPullRequests>>;
};
let inFlight: Promise<BothResults | null> | undefined;
let settingsRefreshTimer: ReturnType<typeof setTimeout> | undefined;

// Resolved once the module-scope settings above are fully loaded (storage
// reads only — never network). Anything that fetches with these values must
// await it: a cold-started service worker can otherwise serve messages with
// partially-loaded settings, producing 200-OK-but-empty responses (#9) and
// putting network round trips on the startup critical path that gates the
// first popup open after an extension reload (#16).
let settingsReadyResolve!: () => void;
let settingsLoaded = false;
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
  inFlight = undefined;
  if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = undefined;
  updateBadge(0);
}

function scheduleSettingsRefresh() {
  if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = setTimeout(() => {
    settingsRefreshTimer = undefined;
    void fetchBoth().catch((error) => {
      if (!isAbortError(error)) console.error("[BACKGROUND] settings refresh failed:", error);
    });
  }, SETTINGS_REFRESH_DEBOUNCE_MS);
}

async function fetchBoth() {
  await settingsReady;
  if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = undefined;
  if (inFlight) return inFlight;
  // In production, incomplete settings cannot produce a meaningful search.
  if (process.env.DEMO_MODE !== "true" && (!githubToken || !repos.length)) return null;
  const request = (async () => {
    if (githubToken && !username) {
      const generation = settingsGeneration;
      const name = await fetchAuthenticatedUser(githubToken, fetchController.signal).catch(() => "");
      if (generation !== settingsGeneration) return null;
      username = name;
      if (name) await saveCachedUsername(name);
    }
    const context = snapshotSettings();
    const [review, mine] = await Promise.all([
      fetchOpenPullRequests(context.githubToken, context.repos, context.username, context.includeTeamRequests, context.signal),
      fetchMyOpenPullRequests(context.githubToken, context.repos, context.username, context.signal),
    ]);
    if (!isCurrent(context)) return null;
    const fetchedAt = Date.now();
    await writeBothCaches(
      { ...review, repos: context.repos, fetchedAt },
      { ...mine, repos: context.repos, fetchedAt }
    );
    if (!isCurrent(context)) return null;
    updateBadge(review.prs.length);
    return { review, mine };
  })();
  inFlight = request;
  try {
    return await request;
  } finally {
    if (inFlight === request) inFlight = undefined;
  }
}

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
  console.log("[BACKGROUND] loaded settings, user:", username);
  settingsLoaded = true;
  settingsReadyResolve();

  const cached = await readCache("review");
  updateBadge(cached?.prs.length ?? 0);
};

startSettings().catch((e) => {
  console.error("[BACKGROUND] settings load failed:", e);
  settingsLoaded = true;
  settingsReadyResolve(); // never leave message handlers waiting forever
});

chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void fetchBoth().catch((error) => {
      if (!isAbortError(error)) console.error("[BACKGROUND] alarm refresh failed:", error);
    });
  }
});

async function handleSettingsChange(changes: Record<string, chrome.storage.StorageChange>) {
  if (!changes.githubToken && !changes.repos && !changes.includeTeamRequests) return;

  invalidateFetches();
  await clearCache();

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
  if (changes.githubToken) await saveCachedUsername("");
  scheduleSettingsRefresh();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (settingsLoaded) {
    void handleSettingsChange(changes);
  } else {
    settingsReady.then(() => handleSettingsChange(changes));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[BACKGROUND] received message:", message, sender);

  if (message.action === "GET_PULL_REQUESTS") {
    fetchBoth().then((result) => {
      if (result) sendResponse({ action: "PULL_REQUESTS", ...result });
    }).catch((error) => {
      if (!isAbortError(error)) console.error("[BACKGROUND] pull-request request failed:", error);
    });
    return true;
  }

  return false;
});
