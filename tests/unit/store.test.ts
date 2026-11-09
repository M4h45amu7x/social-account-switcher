// docs/design.md 8.3 test 9, plus settings and the other store changes.
import { describe, expect, test } from 'bun:test';
import {
  addAccount,
  DEFAULT_SETTINGS,
  emptyStore,
  findAccount,
  initialsOf,
  loadStore,
  migrate,
  normalizeLabel,
  removeAccount,
  renameAccount,
  STORE_KEY,
  type StoreV1,
  saveStore,
  setActive,
  updateAccount,
  updateSettings,
} from '../../src/lib/store';
import { fakeStorageArea } from '../fakes/chrome';

const add = (store: StoreV1, input: Parameters<typeof addAccount>[1], id = 'a1') => {
  const r = addAccount(store, input, { id, now: 100 });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('accounts (test 9)', () => {
  test('a new account gets defaults and initials', () => {
    const { store, account } = add(emptyStore(), {
      platform: 'facebook',
      label: '  Work   page ',
      platformUserId: '1001',
    });
    expect(account).toEqual({
      id: 'a1',
      platform: 'facebook',
      label: 'Work page',
      initials: 'WP',
      platformUserId: '1001',
      status: 'ok',
      createdAt: 100,
      lastUsedAt: null,
      sessionCapturedAt: null,
    });
    expect(store.accounts).toEqual([account]);
  });

  test('the same platformUserId twice is a duplicate', () => {
    const { store } = add(emptyStore(), {
      platform: 'facebook',
      label: 'A',
      platformUserId: '1001',
    });
    expect(
      addAccount(
        store,
        { platform: 'facebook', label: 'B', platformUserId: '1001' },
        { id: 'a2', now: 1 },
      ),
    ).toEqual({ ok: false, error: 'duplicate' });
    expect(
      addAccount(
        store,
        { platform: 'instagram', label: 'B', platformUserId: '1001' },
        { id: 'a2', now: 1 },
      ).ok,
    ).toBe(true);
    expect(
      addAccount(
        store,
        { platform: 'facebook', label: 'B', platformUserId: '1002' },
        { id: 'a2', now: 1 },
      ).ok,
    ).toBe(true);
  });

  test('YouTube duplicates are the same authuser and pageid', () => {
    const { store, account } = add(emptyStore(), {
      platform: 'youtube',
      label: 'Channel',
      youtube: { authuser: 1, pageid: '77' },
    });
    expect(account.youtube).toEqual({ authuser: 1, pageid: '77' });
    const again = (y: { authuser: number; pageid?: string }) =>
      addAccount(store, { platform: 'youtube', label: 'X', youtube: y }, { id: 'a2', now: 1 });
    expect(again({ authuser: 1, pageid: '77' })).toEqual({ ok: false, error: 'duplicate' });
    expect(again({ authuser: 1 }).ok).toBe(true);
    expect(again({ authuser: 2, pageid: '77' }).ok).toBe(true);
  });

  test.each(['', '   ', 'x'.repeat(41), 'ก'.repeat(41)])('label %p is rejected', (label) => {
    expect(addAccount(emptyStore(), { platform: 'facebook', label }, { id: 'a', now: 1 })).toEqual({
      ok: false,
      error: 'invalid_label',
    });
  });

  test('40 characters is allowed, counted as characters not bytes', () => {
    expect(normalizeLabel('ก'.repeat(40))).toEqual({ ok: true, value: 'ก'.repeat(40) });
    expect(normalizeLabel('😀'.repeat(40)).ok).toBe(true);
  });

  test('rename validates the label and refreshes initials', () => {
    const { store } = add(emptyStore(), {
      platform: 'instagram',
      label: 'Old',
      platformUserId: '9',
    });
    const renamed = renameAccount(store, 'a1', 'new name');
    expect(renamed.ok && findAccount(renamed.value, 'a1')).toMatchObject({
      label: 'new name',
      initials: 'NN',
    });
    expect(renameAccount(store, 'a1', ' ')).toEqual({ ok: false, error: 'invalid_label' });
    expect(renameAccount(store, 'nope', 'x')).toEqual({ ok: false, error: 'not_found' });
  });

  test('update changes status and timestamps only on that account', () => {
    let store = add(emptyStore(), { platform: 'facebook', label: 'A', platformUserId: '1' }).store;
    store = add(store, { platform: 'facebook', label: 'B', platformUserId: '2' }, 'a2').store;
    const r = updateAccount(store, 'a2', {
      status: 'expired',
      lastUsedAt: 5,
      sessionCapturedAt: 6,
    });
    expect(r.ok && r.value.accounts.map((a) => a.status)).toEqual(['ok', 'expired']);
    expect(updateAccount(store, 'x', { status: 'ok' })).toEqual({ ok: false, error: 'not_found' });
  });

  test("remove also clears the platform's active account", () => {
    const { store } = add(emptyStore(), { platform: 'facebook', label: 'A', platformUserId: '1' });
    const active = setActive(store, 'facebook', 'a1');
    if (!active.ok) throw new Error();
    expect(active.value.active.facebook).toBe('a1');
    const removed = removeAccount(active.value, 'a1');
    expect(removed.ok && removed.value).toMatchObject({ accounts: [], active: { facebook: null } });
    expect(removeAccount(store, 'x')).toEqual({ ok: false, error: 'not_found' });
    const other = add(store, { platform: 'facebook', label: 'B', platformUserId: '2' }, 'a2').store;
    const kept = removeAccount({ ...other, active: { ...other.active, facebook: 'a2' } }, 'a1');
    expect(kept.ok && kept.value.active.facebook).toBe('a2');
  });

  test('setActive only accepts an account of that platform', () => {
    const { store } = add(emptyStore(), { platform: 'facebook', label: 'A', platformUserId: '1' });
    expect(setActive(store, 'instagram', 'a1')).toEqual({ ok: false, error: 'not_found' });
    expect(setActive(store, 'facebook', 'missing')).toEqual({ ok: false, error: 'not_found' });
    const cleared = setActive(store, 'facebook', null);
    expect(cleared.ok && cleared.value.active.facebook).toBeNull();
  });
});

describe('initials', () => {
  test.each([
    ['Work page', 'WP'],
    ['alice', 'A'],
    ['  ', '?'],
    ['แมวส้ม กินข้าว', 'ม'],
    ['เพจร้าน', 'พ'],
    ['Shop ร้าน', 'S'],
    ['@ 2nd account', '2A'],
  ])('%p → %p', (label, expected) => {
    expect(initialsOf(label)).toBe(expected);
  });
});

describe('settings', () => {
  test('default to system theme and auto language', () => {
    expect(emptyStore().settings).toEqual({ theme: 'system', language: 'auto' });
    expect(DEFAULT_SETTINGS).toEqual({ theme: 'system', language: 'auto' });
  });

  test('a field left undefined changes nothing', () => {
    const r = updateSettings(emptyStore(), { theme: 'dark', language: undefined });
    expect(r.ok && r.value.settings).toEqual({ theme: 'dark', language: 'auto' });
  });

  test('accept known values and reject others', () => {
    const r = updateSettings(emptyStore(), { theme: 'dark', language: 'th' });
    expect(r.ok && r.value.settings).toEqual({ theme: 'dark', language: 'th' });
    expect(updateSettings(emptyStore(), { theme: 'neon' as 'dark' })).toEqual({
      ok: false,
      error: 'invalid_setting',
    });
    expect(updateSettings(emptyStore(), { language: 'fr' as 'en' })).toEqual({
      ok: false,
      error: 'invalid_setting',
    });
  });
});

describe('migrate (test 9)', () => {
  test('nothing stored gives an empty store', () => {
    expect(migrate(undefined)).toEqual({ ok: true, value: emptyStore() });
    expect(migrate(null)).toEqual({ ok: true, value: emptyStore() });
  });

  test('a v1 store without settings gets the defaults, and unknown values are replaced', () => {
    const { store } = add(emptyStore(), { platform: 'facebook', label: 'A', platformUserId: '1' });
    const { settings: _drop, ...noSettings } = store;
    expect(migrate(noSettings)).toEqual({ ok: true, value: store });
    const odd = migrate({
      ...store,
      settings: { theme: 'neon', language: 'th' },
      active: { facebook: 'a1', instagram: 7 },
    });
    expect(odd.ok && odd.value.settings).toEqual({ theme: 'system', language: 'th' });
    expect(odd.ok && odd.value.active).toEqual({ facebook: 'a1', instagram: null, youtube: null });
    expect(migrate({ ...store, active: 'junk', vault: null })).toMatchObject({
      ok: true,
      value: { active: { facebook: null }, vault: null },
    });
  });

  test('a vault that is present but malformed refuses the load instead of being dropped', () => {
    const { store } = add(emptyStore(), { platform: 'facebook', label: 'A', platformUserId: '1' });
    expect(migrate({ ...store, vault: 'junk' })).toEqual({ ok: false, error: 'unknown_schema' });
    expect(migrate({ ...store, vault: { kdf: {}, iv: 1 } })).toEqual({
      ok: false,
      error: 'unknown_schema',
    });
  });

  test('malformed accounts are set aside in quarantine, the rest load, nothing is lost', async () => {
    let { store } = add(emptyStore(), { platform: 'facebook', label: 'Good', platformUserId: '1' });
    store = add(
      store,
      { platform: 'youtube', label: 'Tube', youtube: { authuser: 2, pageid: 'p' } },
      'y1',
    ).store;
    const good = store.accounts;
    const bad = [
      'text',
      null,
      { ...good[0], id: '' },
      { ...good[0], id: 'x1', platform: 'myspace' },
      { ...good[0], id: 'x2', label: '' },
      { ...good[0], id: 'x3', status: 'weird' },
      { ...good[0], id: 'x4', createdAt: 'yesterday' },
      { ...good[0], id: 'x5', lastUsedAt: 'never' },
      { ...good[0], id: 'x6', platformUserId: undefined },
      { ...good[1], id: 'y2', youtube: { authuser: -1 } },
      { ...good[1], id: 'y3', youtube: { authuser: 0, pageid: 5 } },
      { ...good[1], id: 'y4', youtube: null },
      { ...good[0] }, // a second account with the same id
    ];
    const raw = {
      ...store,
      accounts: [...good, ...bad],
      active: { facebook: 'a1', instagram: 'x1', youtube: 'gone' },
    };
    const loaded = migrate(raw);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.accounts).toEqual(good);
    expect(loaded.value.quarantine).toEqual(bad);
    expect(loaded.value.active).toEqual({ facebook: 'a1', instagram: null, youtube: null });

    // Saving and loading again keeps the quarantined entries, and does not quarantine them twice.
    const local = fakeStorageArea();
    await saveStore(local, loaded.value);
    const again = await loadStore(local);
    expect(again.ok && again.value.quarantine).toEqual(bad);
    expect(migrate(store)).toEqual({ ok: true, value: store });
  });

  test.each([
    { schemaVersion: 2, accounts: [] },
    { schemaVersion: 1 },
    'text',
    [1, 2],
    { accounts: [] },
  ])('an unknown schema %p is refused', (raw) => {
    expect(migrate(raw)).toEqual({ ok: false, error: 'unknown_schema' });
  });

  test('loading an unknown schema leaves the stored data untouched', async () => {
    const local = fakeStorageArea();
    const future = { schemaVersion: 2, accounts: [{ id: 'keep-me' }], extra: { a: 1 } };
    await local.set({ [STORE_KEY]: future });
    expect(await loadStore(local)).toEqual({ ok: false, error: 'unknown_schema' });
    expect(local.dump()).toEqual({ [STORE_KEY]: future });
  });

  test('save then load round-trips', async () => {
    const local = fakeStorageArea();
    const { store } = add(emptyStore(), {
      platform: 'youtube',
      label: 'Ch',
      youtube: { authuser: 0 },
    });
    await saveStore(local, store);
    expect(await loadStore(local)).toEqual({ ok: true, value: store });
  });
});
