import { fetchAuthenticatedUser, fetchOpenPullRequests } from "./fetchPullRequests";

let githubToken: string = "";
let repos: string[] = [];
let username: string = "";

chrome.storage.sync.get({ githubToken: "", repos: [] }, async (stored) => {
  githubToken = stored.githubToken;
  repos = stored.repos;
  if (githubToken) {
    username = await fetchAuthenticatedUser(githubToken).catch(() => "");
    console.log("[BACKGROUND] loaded settings, user:", username);
  } else {
    console.log("[BACKGROUND] loaded settings from storage");
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
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[BACKGROUND] received message:", message, sender);

  if (message.action === "GET_PULL_REQUESTS") {
    fetchOpenPullRequests(githubToken, repos, username).then(({ prs, errors }) => {
      sendResponse({ action: "PULL_REQUESTS", payload: prs, errors });
    });
    return true; // Keep the message channel open for sendResponse
  }

  return true; // Keep the message channel open for sendResponse
});
