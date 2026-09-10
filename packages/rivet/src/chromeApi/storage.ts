import { dbDelete, dbGetEntries, dbGetAllKeys, dbPutEntries, EXT_STORAGE_STORE } from "../db";
import type { RivetRegistry } from "../registry";
import { cloneForRealm } from "./common";
import type { ChromeApiContext } from "./context";

async function storageGet(
  extId: string,
  area: string,
  keys: unknown,
): Promise<Record<string, unknown>> {
  const prefix = `${extId}/${area}/`;
  const requested = typeof keys === "string" ? [keys]
    : Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string")
    : keys && typeof keys === "object" ? Object.keys(keys) : [];
  const entries = await dbGetEntries(
    EXT_STORAGE_STORE,
    keys === null || keys === undefined
      ? IDBKeyRange.bound(prefix, `${extId}/${area}0`, false, true)
      : [...new Set(requested)].map((key) => prefix + key),
  );
  const defaults = keys && typeof keys === "object" && !Array.isArray(keys)
    ? Object.entries(keys) : [];
  return Object.fromEntries([
    ...defaults,
    ...entries.map(([key, value]) => [key.slice(prefix.length), value]),
  ]);
}

async function storageSet(
  extId: string,
  area: string,
  items: Record<string, unknown>,
): Promise<void> {
  await dbPutEntries(
    EXT_STORAGE_STORE,
    Object.entries(items).map(([key, value]) => [`${extId}/${area}/${key}`, value] as const),
  );
}

async function storageRemove(
  extId: string,
  area: string,
  keys: string | string[],
): Promise<void> {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    await dbDelete(EXT_STORAGE_STORE, `${extId}/${area}/${key}`);
  }
}

async function storageClear(extId: string, area: string): Promise<void> {
  const allKeys = await dbGetAllKeys(EXT_STORAGE_STORE);
  const prefix = `${extId}/${area}/`;
  for (const key of allKeys.filter(
    (candidate) =>
      typeof candidate === "string" && candidate.startsWith(prefix),
  )) {
    await dbDelete(EXT_STORAGE_STORE, key);
  }
}

async function storageGetKeys(extId: string, area: string): Promise<string[]> {
  const allKeys = await dbGetAllKeys(EXT_STORAGE_STORE);
  const prefix = `${extId}/${area}/`;
  return (
    allKeys.filter(
      (key) => typeof key === "string" && key.startsWith(prefix),
    ) as string[]
  ).map((key) => key.slice(prefix.length));
}

function makeStorageArea(
  extId: string,
  area: string,
  realm: Window,
  registry: RivetRegistry,
) {
  const broadcastChanges = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  ) => {
    if (!Object.keys(changes).length) return;
    registry.broadcast(extId, (events) => events.storageOnChanged, [
      cloneForRealm(realm, changes),
      area,
    ]);
  };
  return {
    get: (
      keys?: unknown | ((items: Record<string, unknown>) => void),
      cb?: (items: Record<string, unknown>) => void,
    ) => {
      const callback =
        typeof keys === "function"
          ? (keys as (items: Record<string, unknown>) => void)
          : cb;
      const requestedKeys = typeof keys === "function" ? null : keys;
      const promise = storageGet(extId, area, requestedKeys).then((result) =>
        cloneForRealm(realm, result),
      );
      if (callback) promise.then(callback);
      return promise;
    },
    set: (items: Record<string, unknown>, cb?: () => void) => {
      const promise = storageGet(extId, area, Object.keys(items)).then(
        async (previous) => {
          await storageSet(extId, area, items);
          const changes: Record<
            string,
            { oldValue?: unknown; newValue?: unknown }
          > = {};
          for (const [key, newValue] of Object.entries(items)) {
            const oldValue = previous[key];
            if (Object.is(oldValue, newValue)) continue;
            changes[key] = {
              ...(oldValue === undefined ? {} : { oldValue }),
              newValue,
            };
          }
          broadcastChanges(changes);
        },
      );
      if (cb) promise.then(cb);
      return promise;
    },
    remove: (keys: string | string[], cb?: () => void) => {
      const promise = storageGet(extId, area, keys).then(async (previous) => {
        await storageRemove(extId, area, keys);
        const changes: Record<string, { oldValue?: unknown }> = {};
        for (const [key, oldValue] of Object.entries(previous)) {
          changes[key] = { oldValue };
        }
        broadcastChanges(changes);
      });
      if (cb) promise.then(cb);
      return promise;
    },
    clear: (cb?: () => void) => {
      const promise = storageGet(extId, area, null).then(async (previous) => {
        await storageClear(extId, area);
        const changes: Record<string, { oldValue?: unknown }> = {};
        for (const [key, oldValue] of Object.entries(previous)) {
          changes[key] = { oldValue };
        }
        broadcastChanges(changes);
      });
      if (cb) promise.then(cb);
      return promise;
    },
    getBytesInUse: (
      keys?: unknown | ((bytes: number) => void),
      cb?: (bytes: number) => void,
    ) => {
      const callback = typeof keys === "function" ? keys : cb;
      callback?.(0);
      return Promise.resolve(0);
    },
    getKeys: (cb?: (keys: string[]) => void) => {
      const promise = storageGetKeys(extId, area);
      if (cb) promise.then(cb);
      return promise;
    },
  };
}

function makeManagedStorageArea(realm: Window) {
  const get = (
    keys?: unknown | ((items: Record<string, unknown>) => void),
    cb?: (items: Record<string, unknown>) => void,
  ) => {
    const callback =
      typeof keys === "function"
        ? (keys as (items: Record<string, unknown>) => void)
        : cb;
    const requestedKeys = typeof keys === "function" ? undefined : keys;
    const result: Record<string, unknown> = {};
    if (
      requestedKeys &&
      typeof requestedKeys === "object" &&
      !Array.isArray(requestedKeys)
    ) {
      Object.assign(result, requestedKeys as Record<string, unknown>);
    }
    const promise = Promise.resolve(cloneForRealm(realm, result));
    if (callback) promise.then(callback);
    return promise;
  };

  return {
    get,
    getBytesInUse: (
      keys?: unknown | ((bytes: number) => void),
      cb?: (bytes: number) => void,
    ) => {
      const callback = typeof keys === "function" ? keys : cb;
      callback?.(0);
      return Promise.resolve(0);
    },
    getKeys: (cb?: (keys: string[]) => void) => {
      const keys = cloneForRealm(realm, [] as string[]);
      cb?.(keys);
      return Promise.resolve(keys);
    },
  };
}

export function createStorageApi(context: ChromeApiContext) {
  const { extId, realm, registry, events } = context;
  return {
    local: makeStorageArea(extId, "local", realm, registry),
    sync: makeStorageArea(extId, "sync", realm, registry),
    session: makeStorageArea(extId, "session", realm, registry),
    managed: makeManagedStorageArea(realm),
    onChanged: events.storageOnChanged.toApi(),
  };
}
