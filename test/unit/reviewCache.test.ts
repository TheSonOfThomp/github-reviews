import { describe, it, expect, beforeEach } from "vitest";
import { createChromeMock } from "../mocks/chrome";
import {
  readCache,
  writeCache,
  clearCache,
  CACHE_STORAGE_KEY,
  type CacheEntry,
} from "../../src/background/reviewCache";

const entry = (repo: string): CacheEntry => ({
  prs: [],
  errors: [],
  repos: [repo],
  fetchedAt: 1234,
});

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  globalThis.chrome = chromeMock as unknown as typeof chrome;
});

describe("readCache", () => {
  it("returns null when nothing is cached", async () => {
    await expect(readCache("review")).resolves.toBeNull();
  });

  it("returns the stored entry for the given view mode", async () => {
    await writeCache("review", entry("acme/widgets"));

    await expect(readCache("review")).resolves.toEqual(entry("acme/widgets"));
  });

  it("does not return entries stored under the other view mode", async () => {
    await writeCache("review", entry("acme/widgets"));

    await expect(readCache("mine")).resolves.toBeNull();
  });
});

describe("writeCache", () => {
  it("preserves the sibling view mode's entry", async () => {
    await writeCache("review", entry("acme/widgets"));
    await writeCache("mine", entry("acme/gadgets"));

    const stored = chromeMock.__stores.local[CACHE_STORAGE_KEY] as Record<string, CacheEntry>;
    expect(stored.review).toEqual(entry("acme/widgets"));
    expect(stored.mine).toEqual(entry("acme/gadgets"));
  });
});

describe("clearCache", () => {
  it("removes the whole cache including both view modes", async () => {
    await writeCache("review", entry("acme/widgets"));
    await writeCache("mine", entry("acme/gadgets"));

    await clearCache();

    expect(chromeMock.__stores.local[CACHE_STORAGE_KEY]).toBeUndefined();
    await expect(readCache("review")).resolves.toBeNull();
    await expect(readCache("mine")).resolves.toBeNull();
  });
});
