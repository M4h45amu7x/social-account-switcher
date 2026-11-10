import { expect, test } from 'bun:test';
import { createTikTokPlatform, TIKTOK_EXPERIMENT } from '../../src/background/platforms/tiktok';
import { createRouter } from '../../src/background/router';
import { fakeChrome, MANIFEST_HOSTS } from '../fakes/chrome';
import { makeDeps, PASSWORD } from '../fakes/harness';

function context() {
  const c = fakeChrome({
    tabs: [
      { url: 'https://www.tiktok.com/', active: true },
      { url: 'https://www.tiktok.com/', active: true },
    ],
    hostPermissions: [...MANIFEST_HOSTS, 'https://*.tiktok.com/*'],
  });
  c.scripting.pageResults.set(1, { state: 'signed_in', viewerId: 'window-A' });
  c.scripting.pageResults.set(2, { state: 'signed_in', viewerId: 'window-B' });
  const queries: unknown[] = [];
  c.tabs.query = async (options) => {
    queries.push(options);
    // Only tab2 belongs to the current window. Tab1 is active in another window.
    return 'currentWindow' in options && options.currentWindow ? [c.tabs.tabs[1]!] : c.tabs.tabs;
  };
  const platform = createTikTokPlatform(c, { ...TIKTOK_EXPERIMENT, enabled: true });
  const deps = makeDeps(c, {
    readCurrent: async () => ({ ok: false, error: 'not_signed_in' }),
    switchTo: async () => ({ ok: true, value: { reloadedTabs: 0 } }),
  });
  deps.platforms = { ...deps.platforms, tiktok: platform };
  const router = createRouter(deps);
  const send = (value: unknown) =>
    router.handle(value, {
      id: c.runtime.id,
      url: `chrome-extension://${c.runtime.id}/popup/index.html`,
    });
  return { c, queries, platform, send };
}

test('TikTok explicit context reads that tab directly without querying other windows', async () => {
  const h = context();
  expect(await h.platform.probe?.(2)).toEqual({ ok: true, value: 'window-B' });
  expect(h.c.scripting.calls.map((c) => c.tabId)).toEqual([2]);
  expect(h.queries).toEqual([]);
});

test('internal TikTok capture without context queries only the active current-window tab', async () => {
  const h = context();
  expect(await h.platform.probe?.()).toEqual({ ok: true, value: 'window-B' });
  expect(h.queries).toEqual([
    { url: ['https://*.tiktok.com/*'], active: true, currentWindow: true },
  ]);
  h.c.tabs.tabs[1]!.url = 'https://www.youtube.com/';
  expect(await h.platform.probe?.()).toEqual({ ok: false, error: 'no_tiktok_tab' });
  expect(h.c.scripting.calls.map((c) => c.tabId)).toEqual([2]);
});

test('TikTok closed or navigated explicit tab never falls back to another window', async () => {
  const h = context();
  expect(await h.platform.probe?.(99)).toEqual({ ok: false, error: 'no_tiktok_tab' });
  h.c.tabs.tabs[1]!.url = 'https://www.youtube.com/';
  expect(await h.platform.probe?.(2)).toEqual({ ok: false, error: 'no_tiktok_tab' });
  expect(h.c.scripting.calls).toEqual([]);
  expect(h.queries).toEqual([]);
});

test('router forwards TikTok tabId for probe, both add/update viewer reads and saved-account matching', async () => {
  const h = context();
  expect((await h.send({ type: 'vault.setup', password: PASSWORD })).ok).toBe(true);
  await h.c.cookies.set({
    url: 'https://www.tiktok.com/',
    name: 'sid_tt',
    value: 'fixture',
    secure: true,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });
  expect(await h.send({ type: 'account.probe', platform: 'tiktok', tabId: 2 })).toEqual({
    ok: true,
    value: { tail: 'ow-B', accountId: null },
  });
  const added = await h.send({
    type: 'account.addCurrent',
    platform: 'tiktok',
    label: 'B',
    tabId: 2,
  });
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(added.error);
  const account = added.value as { id: string; platformUserId: string };
  expect(account.platformUserId).toBe('window-B');
  expect(await h.send({ type: 'account.probe', platform: 'tiktok', tabId: 2 })).toEqual({
    ok: true,
    value: { tail: 'ow-B', accountId: account.id },
  });
  expect(
    (await h.send({ type: 'account.updateSession', accountId: account.id, tabId: 2 })).ok,
  ).toBe(true);
  expect(h.c.scripting.calls.map((c) => c.tabId)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  expect(h.queries).toEqual([]);
});

test('contextual TikTok requests with no/closed/unrelated tab never read other windows or mutate storage', async () => {
  const h = context();
  const before = h.c.storage.local.dump();
  for (const tabId of [undefined, 99, 2]) {
    if (tabId === 2) h.c.tabs.tabs[1]!.url = 'https://www.youtube.com/';
    for (const type of ['account.probe', 'account.addCurrent']) {
      expect(
        await h.send({
          type,
          platform: 'tiktok',
          ...(type === 'account.addCurrent' ? { label: 'wrong' } : {}),
          ...(tabId === undefined ? {} : { tabId }),
        }),
      ).toEqual({ ok: false, error: 'no_tiktok_tab' });
    }
  }
  expect(h.c.scripting.calls).toEqual([]);
  expect(h.queries).toEqual([]);
  expect(h.c.storage.local.dump()).toEqual(before);
});
