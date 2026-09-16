import type { PullRequest, RepoError } from "./fetchPullRequests";

export type CacheKey = "review" | "mine"; // matches popover ViewMode

export interface CacheEntry {
  prs: PullRequest[];
  errors: RepoError[];
  repos: string[]; // snapshot of the repos setting used for this fetch
  fetchedAt: number; // Date.now() epoch ms
}

export const CACHE_STORAGE_KEY = "prCache"; // under chrome.storage.local

type StoredCache = Partial<Record<CacheKey, CacheEntry>>;

export function readCache(key: CacheKey): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_STORAGE_KEY], (stored) => {
      resolve((stored[CACHE_STORAGE_KEY] as StoredCache | undefined)?.[key] ?? null);
    });
  });
}

export function writeCache(key: CacheKey, entry: CacheEntry): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CACHE_STORAGE_KEY], (stored) => {
      const cache = (stored[CACHE_STORAGE_KEY] as StoredCache | undefined) ?? {};
      cache[key] = entry;
      chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache }, () => resolve());
    });
  });
}

export function clearCache(): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.remove(CACHE_STORAGE_KEY, () => resolve()));
}
