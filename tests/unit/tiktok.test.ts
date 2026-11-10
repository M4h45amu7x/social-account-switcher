import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  createTikTokPlatform,
  readFixtureViewer,
  TIKTOK_EXPERIMENT,
} from '../../src/background/platforms/tiktok';
import { clear, restore, snapshot } from '../../src/lib/cookies';
import { fakeCookies, fakeScripting, fakeTabs } from '../fakes/chrome';

const hosts = ['https://*.tiktok.com/*'];
const enabled = { ...TIKTOK_EXPERIMENT, enabled: true };
const deps = () => ({
  tabs: fakeTabs([{ url: 'https://www.tiktok.com/', active: true }], hosts),
  scripting: fakeScripting(),
});
afterEach(() => {
  document.body.innerHTML = '';
});
const page = (data: unknown) => {
  document.body.innerHTML = '<script id="__SAM_TIKTOK_VIEWER__" type="application/json"></script>';
  document.querySelector('script')!.textContent = JSON.stringify(data);
};

test('production experiment is disabled before any tab or script access', async () => {
  const d = deps();
  const p = createTikTokPlatform(d);
  expect(await p.probe!()).toEqual({ ok: false, error: 'tiktok_disabled' });
  expect(d.scripting.calls).toEqual([]);
});

test('viewer reader returns only explicit viewer identity, never content author or profile', () => {
  page({
    state: 'signed_in',
    viewerId: 'viewer-123',
    author: { id: 'wrong' },
    email: 'discard@example.test',
  });
  expect(readFixtureViewer()).toEqual({ state: 'signed_in', viewerId: 'viewer-123' });
  page({ author: { id: 'wrong' }, userInfo: { id: 'wrong' } });
  expect(readFixtureViewer()).toEqual({ state: 'unknown' });
});

test.each(
  [
    null,
    [],
    {},
    { state: 'signed_in', viewerId: '' },
    { state: 'signed_in', viewerId: 'a'.repeat(129) },
    { state: 'signed_in', viewerId: '<bad>' },
  ].map((value) => [value]),
)('malformed viewer %j is unknown', (v) => {
  page(v);
  expect(readFixtureViewer()).toEqual({ state: 'unknown' });
});

test('missing, oversized or malformed JSON is unknown, logout/checkpoint explicit', () => {
  expect(readFixtureViewer()).toEqual({ state: 'unknown' });
  page({ state: 'logged_out' });
  expect(readFixtureViewer()).toEqual({ state: 'logged_out' });
  page({ state: 'checkpoint' });
  expect(readFixtureViewer()).toEqual({ state: 'checkpoint' });
  document.querySelector('script')!.textContent = '{';
  expect(readFixtureViewer()).toEqual({ state: 'unknown' });
  document.querySelector('script')!.textContent = ' '.repeat(4097);
  expect(readFixtureViewer()).toEqual({ state: 'unknown' });
});

test('probe executes the actual pure reader in MAIN world, no mutation or network', async () => {
  const d = deps();
  page({ state: 'signed_in', viewerId: '123' });
  const before = document.body.innerHTML;
  const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  const xhrSpy = spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {
    throw new Error('network forbidden');
  });
  let ran = false;
  d.scripting.executeScript = async (options) => {
    expect(options.world).toBe('MAIN');
    expect(options.target).toEqual({ tabId: 1 });
    ran = true;
    return [{ frameId: 0, result: options.func() }];
  };
  expect(await createTikTokPlatform(d, enabled).probe!()).toEqual({ ok: true, value: '123' });
  expect(ran).toBe(true);
  expect(document.body.innerHTML).toBe(before);
  expect(d.tabs.reloaded).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(xhrSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  xhrSpy.mockRestore();
});

test.each([
  [{ state: 'logged_out' }, { ok: true, value: null }],
  [{ state: 'unknown' }, { ok: false, error: 'tiktok_probe_unavailable' }],
  [{ state: 'checkpoint' }, { ok: false, error: 'checkpoint' }],
  [
    { state: 'signed_in', viewerId: 'A' },
    { ok: true, value: 'A' },
  ],
  [
    { state: 'signed_in', viewerId: 123 },
    { ok: false, error: 'tiktok_probe_unavailable' },
  ],
])('probe distinguishes page result %j', async (state, want) => {
  const d = deps();
  d.scripting.pageResults.set(1, state);
  expect(await createTikTokPlatform(d, enabled).probe!()).toEqual(expect.objectContaining(want));
});

test('no tab, spoofed host/scheme, subframes, ambiguous frames and API errors fail closed', async () => {
  const d = deps();
  d.tabs.query = async () => [];
  expect(await createTikTokPlatform(d, enabled).probe!()).toEqual({
    ok: false,
    error: 'no_tiktok_tab',
  });
  for (const url of [
    'https://tiktok.com.evil.test/',
    'https://eviltiktok.com/',
    'http://www.tiktok.com/',
  ]) {
    d.tabs.query = async () => [{ id: 1, url }];
    expect((await createTikTokPlatform(d, enabled).probe!()).ok).toBe(false);
  }
  d.tabs.query = async () => [{ id: 1, url: 'https://www.tiktok.com/', active: true }];
  d.scripting.executeScript = async () => [
    { frameId: 7, result: { state: 'signed_in', viewerId: 'wrong' } },
  ];
  expect((await createTikTokPlatform(d, enabled).probe!()).ok).toBe(false);
  d.scripting.executeScript = async () => [
    { frameId: 0, result: { state: 'logged_out' } },
    { frameId: 0, result: { state: 'signed_in', viewerId: 'wrong' } },
  ];
  expect((await createTikTokPlatform(d, enabled).probe!()).ok).toBe(false);
  d.tabs.query = async () => {
    throw new Error('private');
  };
  expect(await createTikTokPlatform(d, enabled).probe!()).toEqual({
    ok: false,
    error: 'api_error',
  });
});

test('deny-list swaps unknown/account cookies, preserves device cookies, and rejects forged restores', async () => {
  const p = createTikTokPlatform(deps(), enabled);
  const jar = fakeCookies(undefined, [...hosts, 'https://*.evil.test/*']);
  for (const name of [
    'sid_tt',
    'sessionid',
    'ttwid',
    'msToken',
    'unknown',
    'passport_csrf_token',
    'multi_sids',
    'tt_csrf_token',
    'odin_tt',
    'tt_ticket_guard_has_set_public_key',
  ]) {
    await jar.set({
      url: 'https://www.tiktok.com/',
      domain: '.tiktok.com',
      path: '/',
      name,
      value: name,
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
  }
  const saved = await snapshot(jar, p);
  expect(saved.map((c) => c.name).sort()).toEqual([
    'multi_sids',
    'passport_csrf_token',
    'sessionid',
    'sid_tt',
    'tt_csrf_token',
    'unknown',
  ]);
  await clear(jar, p);
  expect(
    jar
      .all()
      .map((c) => c.name)
      .sort(),
  ).toEqual(['msToken', 'odin_tt', 'tt_ticket_guard_has_set_public_key', 'ttwid']);
  expect((await restore(jar, saved, Date.now(), p)).ok).toBe(true);
  const before = jar.all();
  for (const patch of [
    { domain: '.tiktok.com.evil.test' },
    { name: 'msToken' },
    { domain: 'evil@www.tiktok.com' },
  ]) {
    expect(await restore(jar, [{ ...saved[0]!, ...patch }], Date.now(), p)).toEqual({
      ok: false,
      error: 'invalid_session',
    });
    expect(jar.all()).toEqual(before);
  }
});

test('disabled registration is inert and no challenge URL is guessed', async () => {
  const { tiktok } = await import('../../src/background/platforms/tiktok');
  expect(await tiktok.probe?.()).toEqual({ ok: false, error: 'tiktok_disabled' });
  expect(tiktok.isCheckpointUrl('https://www.tiktok.com/challenge')).toBe(false);
  const d = deps();
  d.tabs.query = async () => [{ id: 1, url: 'not a URL' }];
  expect(await createTikTokPlatform(d, enabled).probe?.()).toEqual({
    ok: false,
    error: 'no_tiktok_tab',
  });
});

test('post-load probe stays bound to the loaded tab even if another tab becomes active', async () => {
  const d = deps();
  d.tabs.query = async () => [
    { id: 1, url: 'https://www.tiktok.com/', active: false },
    { id: 2, url: 'https://www.tiktok.com/', active: true },
  ];
  d.scripting.pageResults.set(1, { state: 'signed_in', viewerId: 'loaded-viewer' });
  d.scripting.pageResults.set(2, { state: 'signed_in', viewerId: 'stale-viewer' });
  expect(await createTikTokPlatform(d, enabled).probe?.(1)).toEqual({
    ok: true,
    value: 'loaded-viewer',
  });
  expect(d.scripting.calls[0]?.tabId).toBe(1);
});

test('deny-list is centralized and covers domain/host-only device copies while preserving non-Secure attributes', async () => {
  const p = createTikTokPlatform(deps(), enabled);
  const jar = fakeCookies(undefined, hosts);
  for (const domain of ['.tiktok.com', '.www.tiktok.com', undefined]) {
    for (const name of [
      'msToken',
      'ttwid',
      's_v_web_id',
      'tt_chain_token',
      'odin_tt',
      'tt_ticket_guard_has_set_public_key',
      'new-login-companion',
    ]) {
      await jar.set({
        url: 'https://www.tiktok.com/',
        ...(domain ? { domain } : {}),
        path: '/',
        name,
        value: 'fixture',
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
      });
    }
  }
  const saved = await snapshot(jar, p);
  expect(saved).toHaveLength(3);
  expect(saved.every((c) => c.name === 'new-login-companion' && !c.secure)).toBe(true);
  await clear(jar, p);
  expect(await snapshot(jar, p)).toEqual([]);
  expect(jar.all()).toHaveLength(18);
  expect(await restore(jar, saved, Date.now(), p)).toEqual({ ok: true, value: 3 });
  expect(await snapshot(jar, p)).toEqual(saved);
});
