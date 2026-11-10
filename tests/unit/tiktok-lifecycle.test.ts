import { expect, test } from 'bun:test';
import { readJournal, recoverJournal, writeJournal } from '../../src/background/journal';
import { getKey } from '../../src/background/keyring';
import { createTikTokPlatform, TIKTOK_EXPERIMENT } from '../../src/background/platforms/tiktok';
import { createRouter } from '../../src/background/router';
import { switchAccount } from '../../src/background/switcher';
import { loadStore, migrate } from '../../src/lib/store';
import { readVault, sealCookies } from '../../src/lib/vault';
import { fakeChrome, MANIFEST_HOSTS } from '../fakes/chrome';
import { makeDeps, NOW, PASSWORD } from '../fakes/harness';

async function setup() {
  const c = fakeChrome({
    now: NOW,
    tabs: [{ url: 'https://www.tiktok.com/', active: true }],
    hostPermissions: [...MANIFEST_HOSTS, 'https://*.tiktok.com/*'],
  });
  const p = createTikTokPlatform(c, { ...TIKTOK_EXPERIMENT, enabled: true });
  const deps = makeDeps(c, {
    readCurrent: async () => ({ ok: false, error: 'not_signed_in' }),
    switchTo: async () => ({ ok: true, value: { reloadedTabs: 0 } }),
  });
  deps.platforms = { ...deps.platforms, tiktok: p };
  const router = createRouter(deps);
  const sender = { id: c.runtime.id, url: `chrome-extension://${c.runtime.id}/popup/index.html` };
  const send = (v: unknown) =>
    router.handle(
      v &&
        typeof v === 'object' &&
        'type' in v &&
        ['account.probe', 'account.addCurrent', 'account.updateSession'].includes(String(v.type))
        ? { ...v, tabId: 1 }
        : v,
      sender,
    );
  await send({ type: 'vault.setup', password: PASSWORD });
  const login = async (id: string, token = id) => {
    c.scripting.pageResults.set(1, { state: 'signed_in', viewerId: id });
    await c.cookies.set({
      url: 'https://www.tiktok.com/',
      domain: '.tiktok.com',
      path: '/',
      name: 'sid_tt',
      value: token,
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    for (const name of ['multi_sids', 'tt_csrf_token', 'unrecognized-login-companion']) {
      await c.cookies.set({
        url: 'https://www.tiktok.com/',
        domain: '.tiktok.com',
        path: '/',
        name,
        value: `${name}:${token}`,
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
      });
    }
  };
  const add = async (id: string) => {
    await login(id);
    const result = await send({ type: 'account.addCurrent', platform: 'tiktok', label: id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return (result.value as { id: string }).id;
  };
  const store = async () => {
    const s = await loadStore(deps.local);
    if (!s.ok) throw new Error(s.error);
    return s.value;
  };
  const vault = async () => {
    const s = await store();
    const key = await getKey(deps.session);
    if (!s.vault || !key) throw new Error('locked');
    return readVault(key, s.vault);
  };
  return { c, deps, p, send, login, add, store, vault };
}

test('v0.1.0 migration defaults TikTok active and retains old entries, vault and quarantine', () => {
  const raw = {
    schemaVersion: 1,
    accounts: [
      {
        id: 'fb',
        platform: 'facebook' as const,
        platformUserId: '1',
        label: 'Old',
        initials: 'O',
        status: 'ok' as const,
        createdAt: 1,
        lastUsedAt: null,
        sessionCapturedAt: null,
      },
    ],
    active: { facebook: 'fb', instagram: null, youtube: null },
    vault: null,
    settings: { theme: 'dark', language: 'th' },
    quarantine: [{ old: true }],
  };
  const result = migrate(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.active).toEqual({ ...raw.active, tiktok: null });
  expect(result.value.accounts).toEqual(raw.accounts);
  expect(result.value.quarantine).toEqual(raw.quarantine);
  expect(raw.active).not.toHaveProperty('tiktok');
  const malformed = {
    ...raw,
    accounts: [
      ...raw.accounts,
      { ...raw.accounts[0], id: 'bad', platform: 'tiktok', platformUserId: '' },
    ],
  };
  const bad = migrate(malformed);
  expect(bad.ok && bad.value.accounts).toEqual(raw.accounts);
  expect(bad.ok && bad.value.quarantine?.length).toBe(2);
});

test('TikTok add/update uses viewer ID, captures sessions, rejects unknown or changed viewer and duplicates', async () => {
  const h = await setup();
  const id = await h.add('viewerA');
  expect((await h.store()).accounts[0]?.platformUserId).toBe('viewerA');
  expect(
    await h.send({ type: 'account.addCurrent', platform: 'tiktok', label: 'duplicate' }),
  ).toEqual({ ok: false, error: 'duplicate' });
  await h.login('viewerA', 'rotated');
  expect((await h.send({ type: 'account.updateSession', accountId: id })).ok).toBe(true);
  expect((await h.vault())[id]?.cookies[0]?.value).toBe('rotated');
  h.c.scripting.pageResults.set(1, { state: 'unknown' });
  expect(await h.send({ type: 'account.probe', platform: 'tiktok' })).toEqual({
    ok: false,
    error: 'tiktok_probe_unavailable',
  });
  expect(await h.send({ type: 'account.updateSession', accountId: id })).toEqual({
    ok: false,
    error: 'tiktok_probe_unavailable',
  });
  await h.login('other');
  expect(await h.send({ type: 'account.updateSession', accountId: id })).toEqual({
    ok: false,
    error: 'wrong_account',
  });
  h.c.scripting.pageResults.set(1, { state: 'logged_out' });
  expect(await h.send({ type: 'account.probe', platform: 'tiktok' })).toEqual({
    ok: true,
    value: { tail: null, accountId: null },
  });
});

test('switch saves departing rotation and verified target rotation, leaves device cookies unchanged', async () => {
  const h = await setup();
  const a = await h.add('A');
  const b = await h.add('B');
  await h.login('B', 'B-new');
  await h.c.cookies.set({
    url: 'https://www.tiktok.com/',
    path: '/',
    name: 'msToken',
    value: 'device',
    secure: true,
    httpOnly: false,
    sameSite: 'lax',
  });
  h.c.tabs.onLoad = async () => {
    const token = h.c.cookies.all().find((c) => c.name === 'sid_tt')?.value;
    if (token === 'A') {
      await h.login('A', 'A-new');
    }
  };
  expect(await switchAccount(h.deps, 'tiktok', a)).toEqual({
    ok: true,
    value: { reloadedTabs: 1 },
  });
  const v = await h.vault();
  expect(v[a]?.cookies[0]?.value).toBe('A-new');
  expect(v[b]?.cookies[0]?.value).toBe('B-new');
  for (const name of ['multi_sids', 'tt_csrf_token', 'unrecognized-login-companion']) {
    expect(v[a]?.cookies.find((c) => c.name === name)?.value).toBe(`${name}:A-new`);
    expect(v[b]?.cookies.find((c) => c.name === name)?.value).toBe(`${name}:B-new`);
  }
  expect((await h.store()).active.tiktok).toBe(a);
  expect(h.c.cookies.all().find((c) => c.name === 'msToken')?.value).toBe('device');
  expect(await readJournal(h.deps.session, 'tiktok')).toBeNull();
});

test.each(['unknown', 'logged_out', 'checkpoint'])(
  'post-load %s is distinct and rollback is scoped',
  async (state) => {
    const h = await setup();
    const a = await h.add('A');
    await h.add('B');
    h.c.tabs.onLoad = async () => {
      const token = h.c.cookies.all().find((c) => c.name === 'sid_tt')?.value;
      h.c.scripting.pageResults.set(
        1,
        token === 'A' ? { state } : { state: 'signed_in', viewerId: 'B' },
      );
    };
    const result = await switchAccount(h.deps, 'tiktok', a);
    expect(result).toEqual({
      ok: false,
      error:
        state === 'unknown'
          ? 'tiktok_probe_unavailable'
          : state === 'checkpoint'
            ? 'checkpoint'
            : 'expired',
    });
    expect((await h.store()).accounts.find((x) => x.id === a)?.status).toBe(
      state === 'logged_out' ? 'expired' : state === 'checkpoint' ? 'checkpoint' : 'ok',
    );
    expect(h.c.cookies.all().find((c) => c.name === 'sid_tt')?.value).toBe(
      state === 'checkpoint' ? 'A' : 'B',
    );
    for (const name of ['multi_sids', 'tt_csrf_token', 'unrecognized-login-companion']) {
      expect(h.c.cookies.all().find((c) => c.name === name)?.value).toBe(
        `${name}:${state === 'checkpoint' ? 'A' : 'B'}`,
      );
    }
  },
);

test('disabled experiment refuses probe/add/switch before cookies or journals change', async () => {
  const h = await setup();
  const a = await h.add('A');
  await h.add('B');
  h.deps.platforms = { ...h.deps.platforms, tiktok: createTikTokPlatform(h.c) };
  const before = h.c.cookies.all();
  const data = h.c.storage.local.dump();
  expect(await switchAccount(h.deps, 'tiktok', a)).toEqual({ ok: false, error: 'tiktok_disabled' });
  expect(await h.send({ type: 'account.probe', platform: 'tiktok' })).toEqual({
    ok: false,
    error: 'tiktok_disabled',
  });
  expect(
    await h.send({ type: 'account.addCurrent', platform: 'tiktok', label: 'blocked' }),
  ).toEqual({ ok: false, error: 'tiktok_disabled' });
  expect(h.c.cookies.all()).toEqual(before);
  expect(h.c.storage.local.dump()).toEqual(data);
  expect(await readJournal(h.deps.session, 'tiktok')).toBeNull();
});

test.each(['sessions', 'all'] as const)(
  'wipe %s removes TikTok sessions/journal/key, sessions-only keeps YouTube',
  async (scope) => {
    const h = await setup();
    await h.add('A');
    const s = await h.store();
    s.accounts.push({
      id: 'yt',
      platform: 'youtube',
      label: 'YT',
      initials: 'Y',
      youtube: { authuser: 1 },
      status: 'ok',
      createdAt: NOW,
      lastUsedAt: null,
      sessionCapturedAt: null,
    });
    await h.deps.local.set({ store: s });
    await h.deps.session.set({ 'journal.tiktok': { test: true }, unlockFailures: { count: 8 } });
    expect((await h.send({ type: 'vault.wipe', scope })).ok).toBe(true);
    expect((await h.store()).accounts.map((a) => a.id)).toEqual(scope === 'sessions' ? ['yt'] : []);
    expect(await getKey(h.deps.session)).toBeNull();
    expect(h.c.storage.session.dump()).not.toHaveProperty('journal.tiktok');
  },
);

test('recovery verifies restored viewer; unknown/invalid backup retains journal, valid backup clears it', async () => {
  const h = await setup();
  await h.add('A');
  const cookies = (await h.vault())['acc-1']?.cookies ?? [];
  const key = await getKey(h.deps.session);
  if (!key) throw new Error('locked');
  await writeJournal(h.deps.session, {
    platform: 'tiktok',
    fromId: null,
    fromUserId: 'A',
    toId: 'x',
    startedAt: NOW,
    backup: await sealCookies(key, cookies),
  });
  h.c.scripting.pageResults.set(1, { state: 'unknown' });
  expect((await recoverJournal(h.deps)).waiting).toContain('tiktok');
  expect(await readJournal(h.deps.session, 'tiktok')).not.toBeNull();
  h.c.scripting.pageResults.set(1, { state: 'signed_in', viewerId: 'A' });
  expect((await recoverJournal(h.deps)).rolledBack).toContain('tiktok');
  expect(await readJournal(h.deps.session, 'tiktok')).toBeNull();
});

test('failed rollback keeps the original journal and refuses a second switch', async () => {
  const h = await setup();
  const a = await h.add('A');
  await h.add('B');
  h.c.tabs.onLoad = async () => {
    h.c.scripting.pageResults.set(1, { state: 'unknown' });
  };
  expect(await switchAccount(h.deps, 'tiktok', a)).toEqual({ ok: false, error: 'rollback_failed' });
  const journal = await readJournal(h.deps.session, 'tiktok');
  expect(journal).not.toBeNull();
  const before = h.c.cookies.all();
  await h.login('B');
  expect(await switchAccount(h.deps, 'tiktok', a)).toEqual({ ok: false, error: 'rollback_failed' });
  expect(await readJournal(h.deps.session, 'tiktok')).toEqual(journal);
  expect(h.c.cookies.all()).toEqual(before);
});

test('capture rejects a viewer changing around the cookie snapshot', async () => {
  const h = await setup();
  let calls = 0;
  h.c.scripting.executeScript = async () => [
    { frameId: 0, result: { state: 'signed_in', viewerId: ++calls === 1 ? 'A' : 'B' } },
  ];
  const before = h.c.storage.local.dump();
  expect(await h.send({ type: 'account.addCurrent', platform: 'tiktok', label: 'race' })).toEqual({
    ok: false,
    error: 'tiktok_probe_unavailable',
  });
  expect(h.c.storage.local.dump()).toEqual(before);
});

test('recovery preserves device cookies and refuses forged backup before mutation', async () => {
  const h = await setup();
  await h.add('A');
  const key = await getKey(h.deps.session);
  if (!key) throw new Error('locked');
  const cookie = (await h.vault())['acc-1']?.cookies[0];
  if (!cookie) throw new Error('cookie');
  const before = h.c.cookies.all();
  await writeJournal(h.deps.session, {
    platform: 'tiktok',
    fromId: null,
    fromUserId: 'A',
    toId: 'x',
    startedAt: NOW,
    backup: await sealCookies(key, [{ ...cookie, domain: '.tiktok.com.evil.test' }]),
  });
  expect((await recoverJournal(h.deps)).waiting).toContain('tiktok');
  expect(h.c.cookies.all()).toEqual(before);
  expect(await readJournal(h.deps.session, 'tiktok')).not.toBeNull();
});

test('a rejected companion-cookie removal cannot produce a successful mixed session', async () => {
  const h = await setup();
  const a = await h.add('A');
  await h.add('B');
  await h.c.cookies.set({
    url: 'https://www.tiktok.com/',
    domain: '.tiktok.com',
    path: '/',
    name: 'sessionid',
    value: 'B-companion',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });
  const remove = h.c.cookies.remove.bind(h.c.cookies);
  h.c.cookies.remove = async (details) => (details.name === 'sessionid' ? null : remove(details));
  h.c.tabs.onLoad = async () => {
    const token = h.c.cookies.all().find((c) => c.name === 'sid_tt')?.value;
    h.c.scripting.pageResults.set(1, { state: 'signed_in', viewerId: token });
  };
  const result = await switchAccount(h.deps, 'tiktok', a);
  expect(result.ok).toBe(false);
  expect((await h.vault())[a]?.cookies.some((c) => c.value === 'B-companion')).toBe(false);
  expect(await readJournal(h.deps.session, 'tiktok')).not.toBeNull();
});

test.each(['rejected', 'timed_out'])(
  '%s reload cannot verify stale viewer DOM or clear recovery journal',
  async (mode) => {
    const h = await setup();
    const a = await h.add('A');
    await h.login('A', 'rotated-current');
    h.c.tabs.reload = async () => {
      if (mode === 'rejected') throw new Error('reload denied');
    };
    expect(await switchAccount(h.deps, 'tiktok', a)).toEqual({
      ok: false,
      error: 'rollback_failed',
    });
    expect(await readJournal(h.deps.session, 'tiktok')).not.toBeNull();
    expect((await h.vault())[a]?.cookies[0]?.value).toBe('rotated-current');
    expect((await recoverJournal(h.deps)).waiting).toContain('tiktok');
    expect(await readJournal(h.deps.session, 'tiktok')).not.toBeNull();
  },
);
