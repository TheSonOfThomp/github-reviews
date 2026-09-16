import { vi, type Mock } from "vitest";

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

type SyncGetDefaults = Record<string, unknown>;
type StorageCallback = (stored: Record<string, unknown>) => void;

export type MessageListener = (
  message: { action: string } & Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void;

type AlarmListener = (alarm: { name: string }) => void;
type StorageChangedListener = (
  changes: Record<string, StorageChange>,
  area: string
) => void;

export interface ChromeMock {
  storage: {
    sync: {
      get: Mock<(defaults: SyncGetDefaults, cb: StorageCallback) => void>;
      set: Mock<
        (items: Record<string, unknown>, cb?: () => void) => void
      >;
    };
    local: {
      get: Mock<
        (keys: string[] | SyncGetDefaults, cb: StorageCallback) => void
      >;
      set: Mock<
        (items: Record<string, unknown>, cb?: () => void) => void
      >;
      remove: Mock<(key: string, cb?: () => void) => void>;
    };
    onChanged: {
      addListener: (listener: StorageChangedListener) => void;
    };
  };
  alarms: {
    create: Mock<(name: string, info: { periodInMinutes: number }) => void>;
    onAlarm: {
      addListener: (listener: AlarmListener) => void;
    };
  };
  action: {
    setBadgeText: Mock<(details: { text: string }) => void>;
    setBadgeTextColor: Mock<(details: { color: string }) => void>;
    setBadgeBackgroundColor: Mock<(details: { color: string }) => void>;
  };
  runtime: {
    onMessage: {
      addListener: (listener: MessageListener) => void;
    };
  };
  /** Fire a chrome.alarms.onAlarm event. */
  __fireAlarm: (name: string) => void;
  /**
   * Send a chrome.runtime message. Resolves with the sendResponse payload
   * (or undefined if no listener responds).
   */
  __sendMessage: (
    message: { action: string } & Record<string, unknown>
  ) => Promise<unknown>;
  /**
   * Resolve the deferred initial chrome.storage.sync.get — only used when
   * the mock was created with `deferSyncGet` to simulate a cold-started
   * service worker racing its top-level settings load.
   */
  __flushSyncGet: () => void;
  /** Direct access to the in-memory stores (for seeding/asserting). */
  __stores: {
    sync: Record<string, unknown>;
    local: Record<string, unknown>;
  };
}

export function createChromeMock(
  options: {
    sync?: Record<string, unknown>;
    local?: Record<string, unknown>;
    /**
     * Hold the first chrome.storage.sync.get callback back instead of
     * firing it synchronously — lets tests send messages to the module
     * before its top-level settings load completes (the cold-start race).
     */
    deferSyncGet?: boolean;
  } = {}
): ChromeMock {
  const sync: Record<string, unknown> = { ...options.sync };
  const local: Record<string, unknown> = { ...options.local };

  const storageChangedListeners: StorageChangedListener[] = [];
  const alarmListeners: AlarmListener[] = [];
  const messageListeners: MessageListener[] = [];

  let pendingSyncGet: { defaults: SyncGetDefaults; cb: StorageCallback } | undefined;
  const syncGetDeferred = !!options.deferSyncGet;

  const fireStorageChanged = (area: "sync" | "local", changes: Record<string, StorageChange>) => {
    for (const listener of storageChangedListeners) listener(changes, area);
  };

  const localGet = (keys: string[] | SyncGetDefaults, cb: StorageCallback) => {
    const result: Record<string, unknown> = Array.isArray(keys) ? {} : { ...keys };
    const keyList = Array.isArray(keys) ? keys : Object.keys(keys);
    for (const key of keyList) {
      if (key in local) result[key] = local[key];
    }
    cb(result);
  };

  const syncGet = (defaults: SyncGetDefaults, cb: StorageCallback) => {
    if (syncGetDeferred && !pendingSyncGet) {
      pendingSyncGet = { defaults, cb };
      return;
    }
    cb({ ...defaults, ...sync });
  };

  const syncSet = (items: Record<string, unknown>, cb?: () => void) => {
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: sync[key], newValue: value };
      sync[key] = value;
    }
    fireStorageChanged("sync", changes);
    cb?.();
  };

  const localSet = (items: Record<string, unknown>, cb?: () => void) => {
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: local[key], newValue: value };
      local[key] = value;
    }
    fireStorageChanged("local", changes);
    cb?.();
  };

  const localRemove = (key: string, cb?: () => void) => {
    const oldValue = local[key];
    delete local[key];
    fireStorageChanged("local", { [key]: { oldValue } });
    cb?.();
  };

  const sendMessage = (message: { action: string } & Record<string, unknown>) =>
    new Promise((resolve) => {
      let responded = false;
      let async = false;
      const sendResponse = (payload: unknown) => {
        if (!responded) {
          responded = true;
          resolve(payload);
        }
      };
      for (const listener of messageListeners) {
        if (listener(message, { id: "test-sender" }, sendResponse) === true) async = true;
      }
      if (!responded && !async) resolve(undefined);
    });

  return {
    storage: {
      sync: { get: vi.fn(syncGet), set: vi.fn(syncSet) },
      local: { get: vi.fn(localGet), set: vi.fn(localSet), remove: vi.fn(localRemove) },
      onChanged: {
        addListener: (listener) => {
          storageChangedListeners.push(listener);
        },
      },
    },
    alarms: {
      create: vi.fn(),
      onAlarm: {
        addListener: (listener) => {
          alarmListeners.push(listener);
        },
      },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeTextColor: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
    runtime: {
      onMessage: {
        addListener: (listener) => {
          messageListeners.push(listener);
        },
      },
    },
    __fireAlarm: (name) => {
      for (const listener of alarmListeners) listener({ name });
    },
    __sendMessage: sendMessage,
    __flushSyncGet: () => {
      if (pendingSyncGet) {
        const { defaults, cb } = pendingSyncGet;
        pendingSyncGet = undefined;
        cb({ ...defaults, ...sync });
      }
    },
    __stores: { sync, local },
  };
}
