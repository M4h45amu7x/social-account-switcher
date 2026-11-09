// docs/design.md 8.3 test 4b.
import { beforeEach, describe, expect, test } from 'bun:test';
import { dropCachedKey, getKey, lock, storeKey, VAULT_KEY } from '../../src/background/keyring';
import { facebook } from '../../src/background/platforms/facebook';
import { snapshot } from '../../src/lib/cookies';
import { addAccount, emptyStore, loadStore, saveStore } from '../../src/lib/store';
import { createVault, fromBase64, readVault, sealCookies } from '../../src/lib/vault';
import { type FakeChrome, fakeChrome } from '../fakes/chrome';

const SECRET = 'xs-SECRET-value';
let chrome: FakeChrome;

/** The unlock flow as the service worker will run it: vault to storage.local, key to the keyring. */
async function unlockFlow() {
  await chrome.cookies.set({
    url: 'https://www.facebook.com/',
    name: 'xs',
    value: SECRET,
    domain: 'facebook.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'no_restriction',
  });
  const cookies = await snapshot(chrome.cookies, facebook);
  const added = addAccount(
    emptyStore(),
    { platform: 'facebook', label: 'Me', platformUserId: '1' },
    { id: 'a1', now: 1 },
  );
  if (!added.ok) throw new Error('setup');
  const { vault, rawKeyB64 } = await createVault('orange cat naps by the canal', {
    a1: { capturedAt: 1, cookies },
  });
  await saveStore(chrome.storage.local, { ...added.value.store, vault });
  await storeKey(chrome.storage.session, rawKeyB64);
  return { rawKeyB64, cookies };
}

/** Every string anywhere inside a JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

beforeEach(() => {
  chrome = fakeChrome();
  dropCachedKey();
});

describe('keyring', () => {
  test('the key goes to storage.session and nowhere in storage.local', async () => {
    const { rawKeyB64 } = await unlockFlow();
    expect(chrome.storage.session.dump()).toEqual({ [VAULT_KEY]: rawKeyB64 });
    const local = chrome.storage.local.dump();
    expect(Object.keys(local)).toEqual(['store']);
    const keyHex = Buffer.from(fromBase64(rawKeyB64)).toString('hex');
    for (const s of strings(local)) {
      expect(s).not.toBe(rawKeyB64);
      expect(s).not.toContain(rawKeyB64);
      expect(s.toLowerCase()).not.toContain(keyHex);
    }
    expect(JSON.stringify(local)).not.toContain(SECRET);
  });

  test('storeKey locks storage.session to trusted contexts first', async () => {
    await unlockFlow();
    expect(chrome.storage.session.accessLevel).toBe('TRUSTED_CONTEXTS');
  });

  test('getKey still works after the service worker restarts (cache dropped)', async () => {
    const { cookies } = await unlockFlow();
    const first = await getKey(chrome.storage.session);
    expect(first).not.toBeNull();
    expect(await getKey(chrome.storage.session)).toBe(first as CryptoKey); // cached
    dropCachedKey();
    const again = await getKey(chrome.storage.session);
    expect(again).not.toBeNull();
    expect(again?.extractable).toBe(false);
    const store = await loadStore(chrome.storage.local);
    if (!store.ok || !store.value.vault) throw new Error('no vault');
    expect((await readVault(again as CryptoKey, store.value.vault)).a1?.cookies).toEqual(cookies);
  });

  test('lock removes the key and getKey returns null, even with a warm cache', async () => {
    await unlockFlow();
    await getKey(chrome.storage.session);
    await lock(chrome.storage.session);
    expect(chrome.storage.session.dump()).toEqual({});
    expect(await getKey(chrome.storage.session)).toBeNull();
  });

  test('a key removed behind the cache (Chrome closed, another context locked) is not served', async () => {
    await unlockFlow();
    await getKey(chrome.storage.session);
    await chrome.storage.session.remove(VAULT_KEY);
    expect(await getKey(chrome.storage.session)).toBeNull();
  });

  test('a new key in storage.session replaces the cached one', async () => {
    await unlockFlow();
    const first = await getKey(chrome.storage.session);
    const { rawKeyB64 } = await createVault('a different long password', {});
    await chrome.storage.session.set({ [VAULT_KEY]: rawKeyB64 });
    expect(await getKey(chrome.storage.session)).not.toBe(first as CryptoKey);
  });

  test('a malformed key is refused before it reaches storage (QC t-535 note 3)', async () => {
    await expect(storeKey(chrome.storage.session, 'not-a-key')).rejects.toThrow();
    await expect(storeKey(chrome.storage.session, btoa('too short'))).rejects.toThrow();
    expect(chrome.storage.session.dump()).toEqual({});
    expect(await getKey(chrome.storage.session)).toBeNull();
  });

  test('locked from the start gives null', async () => {
    expect(await getKey(chrome.storage.session)).toBeNull();
  });

  test('a journal backup sealed with the key holds no plain-text cookie', async () => {
    const { cookies } = await unlockFlow();
    const key = await getKey(chrome.storage.session);
    const backup = await sealCookies(key as CryptoKey, cookies);
    await chrome.storage.session.set({
      journal: { platform: 'facebook', fromId: 'a1', toId: 'a2', backup },
    });
    const session = JSON.stringify(chrome.storage.session.dump());
    expect(session).not.toContain(SECRET);
    expect(Buffer.from(fromBase64(backup)).includes(Buffer.from(SECRET))).toBe(false);
  });
});
