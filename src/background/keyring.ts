// The only code that touches storage.session.vaultKey (docs/design.md 5 and 6, step 4).
// The raw key lives in storage.session (memory only, cleared when Chrome closes), never in
// storage.local or anywhere on disk. The non-extractable CryptoKey is cached in a variable until the
// service worker is shut down; storage.session is still read on every call, so a lock from anywhere
// takes effect at once.
import type { SessionStorageApi } from '../lib/ports';
import { importSessionKey } from '../lib/vault';

export const VAULT_KEY = 'vaultKey';

let cache: { raw: string; key: CryptoKey } | null = null;

export async function storeKey(session: SessionStorageApi, rawKeyB64: string): Promise<void> {
  // Content scripts must never read the key, even if something changed the access level.
  await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await session.set({ [VAULT_KEY]: rawKeyB64 });
  cache = { raw: rawKeyB64, key: await importSessionKey(rawKeyB64) };
}

/** The unlocked key, or null when the vault is locked. */
export async function getKey(session: SessionStorageApi): Promise<CryptoKey | null> {
  const raw = (await session.get(VAULT_KEY))[VAULT_KEY];
  if (typeof raw !== 'string' || raw === '') {
    cache = null;
    return null;
  }
  if (cache?.raw !== raw) cache = { raw, key: await importSessionKey(raw) };
  return cache.key;
}

export async function lock(session: SessionStorageApi): Promise<void> {
  cache = null;
  await session.remove(VAULT_KEY);
}

/** What a service-worker restart does to this module. Tests use it to simulate one. */
export function dropCachedKey(): void {
  cache = null;
}
