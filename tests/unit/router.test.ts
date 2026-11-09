// The service worker's message handling end to end, on the fakes (design 2, 6 and 8.2).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getKey } from '../../src/background/keyring';
import { createYoutubeSwitcher } from '../../src/background/platforms/youtube';
import type { PopupState } from '../../src/background/router';
import { err } from '../../src/lib/result';
import { loadStore } from '../../src/lib/store';
import { readVault } from '../../src/lib/vault';
import { fakeChrome } from '../fakes/chrome';
import {
  loginAs,
  NOW,
  PASSWORD,
  secretOf,
  startWorker,
  whoIs,
  withAccounts,
} from '../fakes/harness';

type H = Awaited<ReturnType<typeof withAccounts>>['h'];
const state = (h: Pick<H, 'must'>) => h.must<PopupState>({ type: 'state.get' });

async function vaultOf(h: H) {
  const s = await loadStore(h.chrome.storage.local);
  const key = await getKey(h.deps.session);
  if (!s.ok || !s.value.vault || !key) throw new Error('no vault');
  return readVault(key, s.value.vault);
}

// Every console line during these tests, to prove no cookie value or password is printed.
const printed: string[] = [];
const originals = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    console[m] = (...a: unknown[]) =>
      printed.push(
        a.map((x) => (x instanceof Error ? `${x.message}` : JSON.stringify(x))).join(' '),
      );
  }
});
afterEach(() => {
  Object.assign(console, originals);
  const all = printed.join('\n');
  printed.length = 0;
  expect(all).not.toContain('SECRET');
  expect(all).not.toContain(PASSWORD);
});

describe('state and vault', () => {
  test('a fresh install: no vault, no accounts, default settings', async () => {
    const h = await startWorker();
    expect(await state(h)).toEqual({
      accounts: [],
      active: { facebook: null, instagram: null, youtube: null },
      settings: { theme: 'system', language: 'auto' },
      hasVault: false,
      locked: true,
      busy: [],
      quarantined: 0,
      unlockRetryAt: null,
    });
    expect(await h.send({ type: 'vault.unlock', password: PASSWORD })).toEqual(err('no_vault'));
  });

  test('setup refuses a weak password and a second vault', async () => {
    const h = await startWorker();
    expect(await h.send({ type: 'vault.setup', password: 'short' })).toEqual(err('too_short'));
    expect(await h.send({ type: 'vault.setup', password: '0123456789' })).toEqual(
      err('too_simple'),
    );
    await h.must({ type: 'vault.setup', password: PASSWORD });
    expect(await state(h)).toMatchObject({ hasVault: true, locked: false });
    expect(await h.send({ type: 'vault.setup', password: 'another long password' })).toEqual(
      err('vault_exists'),
    );
  });

  test('lock, wrong passwords with the 30-second delay, then unlock', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    expect((await state(h)).locked).toBe(true);
    // Literal numbers on purpose: the design promises five free attempts and 30 seconds.
    for (let i = 0; i < 5; i += 1) {
      expect(await h.send({ type: 'vault.unlock', password: 'wrong password!' })).toEqual(
        err('wrong_password'),
      );
    }
    const retry = (await state(h)).unlockRetryAt;
    expect(retry).toBe(h.chrome.clock.now + 30_000);
    expect(await h.send({ type: 'vault.unlock', password: PASSWORD })).toEqual(
      err('too_many_attempts'),
    );
    h.chrome.clock.now += 29_999;
    expect(await h.send({ type: 'vault.unlock', password: PASSWORD })).toEqual(
      err('too_many_attempts'),
    );
    h.chrome.clock.now += 1;
    expect(await h.send({ type: 'vault.unlock', password: 'still wrong!!' })).toEqual(
      err('wrong_password'),
    );
    expect(await h.send({ type: 'vault.unlock', password: PASSWORD })).toEqual(
      err('too_many_attempts'),
    );
    h.chrome.clock.now += 30_000;
    await h.must({ type: 'vault.unlock', password: PASSWORD });
    expect(await state(h)).toMatchObject({ locked: false, unlockRetryAt: null });
  });

  test('a vault with unsupported KDF settings says so instead of wrong_password', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    const s = await loadStore(h.chrome.storage.local);
    if (!s.ok || !s.value.vault) throw new Error();
    await h.chrome.storage.local.set({
      store: {
        ...s.value,
        vault: { ...s.value.vault, kdf: { ...s.value.vault.kdf, iterations: 1000 } },
      },
    });
    expect(await h.send({ type: 'vault.unlock', password: PASSWORD })).toEqual(
      err('unsupported_vault'),
    );
    expect((await state(h)).unlockRetryAt).toBeNull();
  });

  test('wipe deletes the store, the key and the journals, but not the cookies', async () => {
    const { h } = await withAccounts();
    await h.deps.session.set({ 'journal.facebook': { x: 1 } });
    await h.must({ type: 'vault.wipe' });
    expect(h.chrome.storage.local.dump()).toEqual({});
    expect(h.chrome.storage.session.dump()).toEqual({});
    expect(await state(h)).toMatchObject({ hasVault: false, accounts: [], locked: true });
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
  });

  test('forgot-password wipe (scope sessions) keeps the YouTube shortcuts and drops the rest', async () => {
    const { h } = await withAccounts();
    h.youtube.current = { ok: true, value: { authuser: 1 } };
    const yt = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Channel',
    });
    await h.deps.session.set({ 'journal.facebook': { x: 1 } });
    await h.must({ type: 'vault.wipe', scope: 'sessions' });
    const after = await state(h);
    expect(after).toMatchObject({ hasVault: false, locked: true });
    expect(after.accounts.map((a) => a.id)).toEqual([yt.id]);
    expect(after.active).toEqual({ facebook: null, instagram: null, youtube: yt.id });
    expect(h.chrome.storage.session.dump()).toEqual({});
    // and the user can set a new password straight away
    await h.must({ type: 'vault.setup', password: PASSWORD });
  });

  test('forgot-password wipe of an unreadable store removes it whole', async () => {
    const { h } = await withAccounts();
    await h.chrome.storage.local.set({ store: { schemaVersion: 99 } });
    await h.must({ type: 'vault.wipe', scope: 'sessions' });
    expect(h.chrome.storage.local.dump()).toEqual({});
  });

  test('probe says who is logged in without saving anything', async () => {
    const h = await startWorker();
    expect(await h.must({ type: 'account.probe', platform: 'facebook' })).toEqual({ tail: null });
    await loginAs(h.chrome, 'facebook', '1234567');
    expect(await h.must({ type: 'account.probe', platform: 'facebook' })).toEqual({ tail: '4567' });
    expect((await state(h)).accounts).toEqual([]);
    h.youtube.current = { ok: true, value: { authuser: 2 } };
    expect(await h.must({ type: 'account.probe', platform: 'youtube' })).toEqual({
      tail: '3',
      brand: false,
    });
    h.youtube.current = { ok: true, value: { authuser: 0, pageid: 'brand-9' } };
    expect(await h.must({ type: 'account.probe', platform: 'youtube' })).toEqual({
      tail: '1',
      brand: true,
    });
    h.youtube.current = err('not_signed_in');
    expect(await h.must({ type: 'account.probe', platform: 'youtube' })).toEqual({ tail: null });
    h.youtube.current = err('no_youtube_tab');
    expect(await h.send({ type: 'account.probe', platform: 'youtube' })).toEqual(
      err('no_youtube_tab'),
    );
  });

  test('wipe also works when the store is unreadable', async () => {
    const { h } = await withAccounts();
    await h.chrome.storage.local.set({ store: { schemaVersion: 99 } });
    expect(await h.send({ type: 'state.get' })).toEqual(err('store_unreadable'));
    await h.must({ type: 'vault.wipe' });
    expect((await state(h)).accounts).toEqual([]);
  });

  test('settings.set saves theme and language, one or both', async () => {
    const h = await startWorker();
    await h.must({ type: 'settings.set', theme: 'dark' });
    await h.must({ type: 'settings.set', language: 'th' });
    expect((await state(h)).settings).toEqual({ theme: 'dark', language: 'th' });
  });
});

describe('accounts', () => {
  test('add the current Facebook login: saved in the vault, active, with initials', async () => {
    const { h, ids } = await withAccounts();
    const s = await state(h);
    expect(s.accounts.map((a) => [a.label, a.initials, a.platformUserId])).toEqual([
      ['Alice', 'A', '1001'],
      ['Bob', 'B', '1002'],
      ['Shop', 'S', '2001'],
      ['Studio', 'S', '2002'],
    ]);
    expect(s.active).toEqual({
      facebook: ids['1002'] ?? '',
      instagram: ids['2002'] ?? '',
      youtube: null,
    });
    const vault = await vaultOf(h);
    expect(vault[ids['1001'] ?? '']?.cookies.find((c) => c.name === 'xs')?.value).toBe(
      secretOf('1001'),
    );
    expect(JSON.stringify(h.chrome.storage.local.dump())).not.toContain('SECRET');
  });

  test('add refuses: not logged in, duplicate, no vault, locked, bad label', async () => {
    const { h } = await withAccounts();
    expect(
      await h.send({ type: 'account.addCurrent', platform: 'facebook', label: 'Again' }),
    ).toEqual(err('duplicate'));
    expect(
      await h.send({ type: 'account.addCurrent', platform: 'facebook', label: 'x'.repeat(41) }),
    ).toEqual(err('invalid_label'));
    await loginAs(h.chrome, 'facebook', '7777');
    await h.must({ type: 'vault.lock' });
    expect(
      await h.send({ type: 'account.addCurrent', platform: 'facebook', label: 'New' }),
    ).toEqual(err('locked'));

    const fresh = await startWorker();
    expect(
      await fresh.send({ type: 'account.addCurrent', platform: 'instagram', label: 'x' }),
    ).toEqual(err('not_logged_in'));
    await loginAs(fresh.chrome, 'instagram', '2001');
    expect(
      await fresh.send({ type: 'account.addCurrent', platform: 'instagram', label: 'x' }),
    ).toEqual(err('no_vault'));
  });

  test('update session: only for the same user, and it refreshes the saved cookies', async () => {
    const { h, ids } = await withAccounts();
    expect(await h.send({ type: 'account.updateSession', accountId: ids['1001'] })).toEqual(
      err('wrong_account'),
    );
    await loginAs(h.chrome, 'facebook', '1001');
    await h.chrome.cookies.set({
      url: 'https://www.facebook.com/',
      name: 'xs',
      value: 'xs-SECRET-new',
      domain: 'facebook.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    h.chrome.clock.now += 5000;
    await h.must({ type: 'account.updateSession', accountId: ids['1001'] });
    expect((await vaultOf(h))[ids['1001'] ?? '']?.cookies.find((c) => c.name === 'xs')?.value).toBe(
      'xs-SECRET-new',
    );
    expect((await state(h)).accounts.find((a) => a.id === ids['1001'])).toMatchObject({
      status: 'ok',
      sessionCapturedAt: h.chrome.clock.now,
    });
    expect(await h.send({ type: 'account.updateSession', accountId: 'nope' })).toEqual(
      err('not_found'),
    );
    await h.must({ type: 'vault.lock' });
    expect(await h.send({ type: 'account.updateSession', accountId: ids['1001'] })).toEqual(
      err('locked'),
    );
  });

  test('update session when nobody is logged in', async () => {
    const { h, ids } = await withAccounts();
    await h.must({ type: 'account.switch', accountId: ids['1001'] });
    for (const c of h.chrome.cookies.all().filter((x) => x.name === 'c_user')) {
      await h.chrome.cookies.remove({
        url: `https://${c.domain.replace(/^\./, '')}/`,
        name: 'c_user',
      });
    }
    expect(await h.send({ type: 'account.updateSession', accountId: ids['1001'] })).toEqual(
      err('not_logged_in'),
    );
  });

  test('rename and remove; removing deletes the saved session and needs the vault open', async () => {
    const { h, ids } = await withAccounts();
    await h.must({ type: 'account.rename', accountId: ids['1001'], label: 'Alice W' });
    expect((await state(h)).accounts[0]).toMatchObject({ label: 'Alice W', initials: 'AW' });
    expect(await h.send({ type: 'account.rename', accountId: ids['1001'], label: ' ' })).toEqual(
      err('invalid_label'),
    );
    await h.must({ type: 'vault.lock' });
    expect(await h.send({ type: 'account.remove', accountId: ids['1002'] })).toEqual(err('locked'));
    await h.must({ type: 'vault.unlock', password: PASSWORD });
    await h.must({ type: 'account.remove', accountId: ids['1002'] });
    expect((await state(h)).active.facebook).toBeNull();
    expect(Object.keys(await vaultOf(h))).not.toContain(ids['1002']);
    expect(whoIs(h.chrome, 'facebook')).toBe('1002'); // removing never logs anyone out
    expect(await h.send({ type: 'account.remove', accountId: 'nope' })).toEqual(err('not_found'));
  });

  test('switch through the router, and its errors', async () => {
    const { h, ids } = await withAccounts();
    expect(await h.send({ type: 'account.switch', accountId: ids['1001'] })).toEqual({
      ok: true,
      value: { reloadedTabs: 2 },
    });
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
    await loginAs(h.chrome, 'facebook', '4444');
    expect(await h.send({ type: 'account.switch', accountId: ids['1002'] })).toEqual(
      err('unsaved_current'),
    );
    expect(
      await h.send({ type: 'account.switch', accountId: ids['1002'], force: true }),
    ).toMatchObject({ ok: true });
    expect(await h.send({ type: 'account.switch', accountId: 'nope' })).toEqual(err('not_found'));
  });

  test('while a platform switches, changes to it give busy and wipe waits', async () => {
    const { h, ids } = await withAccounts();
    let release: () => void = () => {};
    const reload = h.chrome.tabs.reload;
    h.chrome.tabs.reload = (id) =>
      new Promise<void>((r) => {
        release = () => {
          reload(id).then(r, r);
        };
      });
    const running = h.send({ type: 'account.switch', accountId: ids['1001'] });
    await new Promise((r) => setTimeout(r, 20));
    expect((await state(h)).busy).toEqual(['facebook']);
    await loginAs(h.chrome, 'instagram', '2009');
    for (const m of [
      { type: 'account.switch', accountId: ids['1002'] },
      { type: 'account.updateSession', accountId: ids['1002'] },
      { type: 'account.remove', accountId: ids['1002'] },
      { type: 'account.addCurrent', platform: 'facebook', label: 'X' },
      { type: 'vault.wipe' },
    ]) {
      expect(await h.send(m)).toEqual(err('busy'));
    }
    // Instagram is not blocked.
    expect(
      (await h.send({ type: 'account.addCurrent', platform: 'instagram', label: 'Other' })).ok,
    ).toBe(true);
    h.chrome.tabs.reload = reload;
    release();
    expect((await running).ok).toBe(true);
  });

  test('adding the current login holds the platform, so a switch at that moment gets busy', async () => {
    const { h, ids } = await withAccounts();
    await loginAs(h.chrome, 'facebook', '1009');
    const adding = h.send({ type: 'account.addCurrent', platform: 'facebook', label: 'Dan' });
    const switching = h.send({ type: 'account.switch', accountId: ids['1001'] });
    expect(await switching).toEqual(err('busy'));
    expect((await adding).ok).toBe(true);
    expect(whoIs(h.chrome, 'facebook')).toBe('1009');
    expect((await state(h)).busy).toEqual([]);
  });

  test('a store that cannot be read stops account messages', async () => {
    const { h, ids } = await withAccounts();
    await h.chrome.storage.local.set({ store: { schemaVersion: 99 } });
    for (const m of [
      { type: 'account.switch', accountId: ids['1001'] },
      { type: 'account.remove', accountId: ids['1001'] },
      { type: 'account.updateSession', accountId: ids['1001'] },
      { type: 'vault.unlock', password: PASSWORD },
    ]) {
      expect(await h.send(m)).toEqual(err('store_unreadable'));
    }
  });

  test('an unexpected exception becomes `internal`, with no details printed', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.cookies.getAll = () => Promise.reject(new Error(`broken ${secretOf('1001')}`));
    expect(await h.send({ type: 'account.switch', accountId: ids['1001'] })).toEqual(
      err('internal'),
    );
    expect(printed).toEqual(['"Request account.switch failed"']);
  });

  test('quarantined accounts are counted for the popup', async () => {
    const { h } = await withAccounts();
    const s = await loadStore(h.chrome.storage.local);
    if (!s.ok) throw new Error();
    await h.chrome.storage.local.set({
      store: { ...s.value, accounts: [...s.value.accounts, { broken: true }] },
    });
    expect((await state(h)).quarantined).toBe(1);
  });
});

describe('YouTube goes through the YoutubeSwitcher interface', () => {
  test('add, switch, update and remove without the vault', async () => {
    const h = await startWorker();
    const added = await h.must<{ id: string; youtube: object }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Brand',
    });
    expect(added.youtube).toEqual({ authuser: 1, pageid: 'brand-7' });
    expect((await state(h)).active.youtube).toBe(added.id);
    expect(
      await h.send({ type: 'account.addCurrent', platform: 'youtube', label: 'Again' }),
    ).toEqual(err('duplicate'));

    expect(await h.send({ type: 'account.switch', accountId: added.id })).toEqual({
      ok: true,
      value: { reloadedTabs: 1 },
    });
    expect(h.youtube.switched).toEqual([{ authuser: 1, pageid: 'brand-7' }]);

    h.youtube.next = err('not_signed_in');
    expect(await h.send({ type: 'account.switch', accountId: added.id })).toEqual(
      err('not_signed_in'),
    );
    expect((await state(h)).accounts[0]?.status).toBe('expired');
    h.youtube.next = err('no_youtube_tab');
    expect(await h.send({ type: 'account.switch', accountId: added.id })).toEqual(
      err('no_youtube_tab'),
    );
    expect((await state(h)).accounts[0]?.status).toBe('expired');

    h.youtube.current = { ok: true, value: { authuser: 3 } };
    await h.must({ type: 'account.updateSession', accountId: added.id });
    expect((await state(h)).accounts[0]).toMatchObject({ youtube: { authuser: 3 }, status: 'ok' });

    h.youtube.current = err('no_youtube_tab');
    expect(await h.send({ type: 'account.updateSession', accountId: added.id })).toEqual(
      err('no_youtube_tab'),
    );
    expect(await h.send({ type: 'account.addCurrent', platform: 'youtube', label: 'x' })).toEqual(
      err('no_youtube_tab'),
    );

    await h.must({ type: 'account.remove', accountId: added.id });
    expect((await state(h)).accounts).toEqual([]);
  });

  test('a YouTube account without its identity cannot be switched', async () => {
    const h = await startWorker();
    const added = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Brand',
    });
    const s = await loadStore(h.chrome.storage.local);
    if (!s.ok) throw new Error();
    // A YouTube account without `youtube` is quarantined on load, so it is simply not found.
    await h.chrome.storage.local.set({
      store: { ...s.value, accounts: [{ ...s.value.accounts[0], youtube: undefined }] },
    });
    expect(await h.send({ type: 'account.switch', accountId: added.id })).toEqual(err('not_found'));
  });
});

describe('YouTube through the real switcher (youtube.ts on the fake Chrome)', () => {
  const YT = 'https://www.youtube.com/watch?v=1';
  async function realYoutube() {
    const chrome = fakeChrome({
      now: NOW,
      tabs: [{ url: YT, active: true }, { url: 'https://www.youtube.com/feed' }],
    });
    const youtube = createYoutubeSwitcher({
      tabs: chrome.tabs,
      scripting: chrome.scripting,
      loadTimeoutMs: 100,
    });
    const h = await startWorker(chrome, youtube);
    const page = (session: unknown) => chrome.scripting.pageResults.set(1, session);
    return { h, page };
  }

  test('add two channels, switch between them, update, with no vault at all', async () => {
    const { h, page } = await realYoutube();
    page({ authuser: 1, pageid: '777', email: 'not copied' });
    const brand = await h.must<{ id: string; youtube: unknown }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Brand',
    });
    expect(brand.youtube).toEqual({ authuser: 1, pageid: '777' });
    page({ authuser: 0 });
    const me = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Me',
    });

    page({ authuser: 1, pageid: '777' });
    // Google's signin answers with a 302 back to `next`, the URL the tab already had.
    const requested: string[] = [];
    h.chrome.tabs.redirect = (to) => {
      requested.push(to);
      return YT;
    };
    expect(await h.send({ type: 'account.switch', accountId: brand.id })).toEqual({
      ok: true,
      value: { reloadedTabs: 1 },
    });
    expect(h.chrome.tabs.tabs[0]?.url).toBe(YT);
    const url = new URL(requested[0] ?? '');
    expect(url.origin + url.pathname).toBe('https://www.youtube.com/signin');
    expect(url.searchParams.get('pageid')).toBe('777');
    expect(url.searchParams.get('next')).toBe('/watch?v=1');
    expect(h.chrome.tabs.reloaded).toEqual([2]);
    const s = await state(h);
    expect(s.active.youtube).toBe(brand.id);
    expect(s.busy).toEqual([]);

    // The page shows another account after the switch: Google account N moved (design 3.3).
    page({ authuser: 3 });
    expect(await h.send({ type: 'account.switch', accountId: me.id })).toEqual(
      err('not_signed_in'),
    );
    expect((await state(h)).accounts.find((a) => a.id === me.id)?.status).toBe('expired');
    page({ authuser: 0 });
    await h.must({ type: 'account.updateSession', accountId: me.id });
    expect((await state(h)).accounts.find((a) => a.id === me.id)?.status).toBe('ok');
  });

  test('Google sends the tab to its login page: not_signed_in', async () => {
    const { h, page } = await realYoutube();
    page({ authuser: 4 });
    const a = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Gone',
    });
    h.chrome.tabs.redirect = () => 'https://accounts.google.com/v3/signin/identifier';
    expect(await h.send({ type: 'account.switch', accountId: a.id })).toEqual(err('not_signed_in'));
    expect(h.chrome.tabs.reloaded).toEqual([]);
  });

  test('while YouTube switches, YouTube messages get busy; Facebook does not', async () => {
    const { h, page } = await realYoutube();
    page({ authuser: 1 });
    const a = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'One',
    });
    h.chrome.tabs.finishLoading = false; // the switch waits until its timeout
    const running = h.send({ type: 'account.switch', accountId: a.id });
    await new Promise((r) => setTimeout(r, 10));
    expect((await state(h)).busy).toEqual(['youtube']);
    for (const m of [
      { type: 'account.switch', accountId: a.id },
      { type: 'account.addCurrent', platform: 'youtube', label: 'Two' },
      { type: 'account.updateSession', accountId: a.id },
      { type: 'account.remove', accountId: a.id },
      { type: 'vault.wipe' },
    ]) {
      expect(await h.send(m)).toEqual(err('busy'));
    }
    expect(await h.send({ type: 'account.addCurrent', platform: 'facebook', label: 'F' })).toEqual(
      err('not_logged_in'),
    );
    expect(await running).toEqual(err('api_error'));
    expect((await state(h)).busy).toEqual([]);
  });

  test('adding a YouTube account holds YouTube until the page has been read', async () => {
    const { h, page } = await realYoutube();
    page({ authuser: 1 });
    const one = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'One',
    });
    page({ authuser: 2 });
    const read = h.chrome.scripting.executeScript;
    let release: () => void = () => {};
    h.chrome.scripting.executeScript = (injection) =>
      new Promise((resolve, reject) => {
        release = () => {
          read(injection).then(resolve, reject);
        };
      });
    const adding = h.send({ type: 'account.addCurrent', platform: 'youtube', label: 'Two' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await h.send({ type: 'account.switch', accountId: one.id })).toEqual(err('busy'));
    release();
    expect((await adding).ok).toBe(true);
    expect((await state(h)).busy).toEqual([]);
  });

  test('no YouTube tab open: add says so', async () => {
    const h = await startWorker(
      fakeChrome({ now: NOW }),
      createYoutubeSwitcher({ tabs: fakeChrome().tabs, scripting: fakeChrome().scripting }),
    );
    expect(await h.send({ type: 'account.addCurrent', platform: 'youtube', label: 'X' })).toEqual(
      err('no_youtube_tab'),
    );
  });

  test('a browser error while reading becomes api_error', async () => {
    const chrome = fakeChrome({ now: NOW });
    chrome.tabs.query = async () => {
      throw new Error('extension context invalidated');
    };
    const youtube = createYoutubeSwitcher({ tabs: chrome.tabs, scripting: chrome.scripting });
    expect(await youtube.readCurrent()).toEqual(err('api_error'));
  });
});
