// Serialized read-modify-write of the store in storage.local.
import type { Mutex } from '../lib/mutex';
import type { StorageAreaApi } from '../lib/ports';
import { err, ok, type Result } from '../lib/result';
import { loadStore, type StoreV1, saveStore } from '../lib/store';

export interface StoreAccess {
  local: StorageAreaApi;
  storeMutex: Mutex;
}

/** storage.local holds a store this version can't read; nothing may be written over it. */
export type StoreError = 'store_unreadable';

export async function readStore(deps: StoreAccess): Promise<Result<StoreV1, StoreError>> {
  const loaded = await loadStore(deps.local);
  return loaded.ok ? loaded : err('store_unreadable');
}

/**
 * Loads the store, lets `change` compute the next one, and saves it, with no other edit in between.
 * Nothing is saved when `change` returns an error.
 */
export function editStore<T, E extends string>(
  deps: StoreAccess,
  change: (store: StoreV1) => Promise<Result<{ store: StoreV1; value: T }, E>>,
): Promise<Result<T, E | StoreError>> {
  return deps.storeMutex.run(async () => {
    const loaded = await readStore(deps);
    if (!loaded.ok) return loaded;
    const next = await change(loaded.value);
    if (!next.ok) return next;
    await saveStore(deps.local, next.value.store);
    return ok(next.value.value);
  });
}

/** editStore() for a change that only needs the store, with no value to return. */
export function patchStore<E extends string>(
  deps: StoreAccess,
  change: (store: StoreV1) => Result<StoreV1, E>,
): Promise<Result<undefined, E | StoreError>> {
  return editStore(deps, async (store) => {
    const next = change(store);
    return next.ok ? ok({ store: next.value, value: undefined }) : next;
  });
}
