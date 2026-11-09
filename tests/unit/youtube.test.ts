import { expect, test } from 'bun:test';
import * as youtube from '../../src/background/platforms/youtube';
import { fakeYouTube } from '../fakes/youtube';

// A missing URL builder or accepting off-site redirects must fail this contract.
test('YouTube builds the multi-login URL and discards an external next URL', () => {
  expect(youtube.buildSignInUrl({ authuser: 2 }, 'https://evil.example/watch')).toEqual({
    ok: true,
    value: 'https://www.youtube.com/signin?action_handle_signin=true&authuser=2&next=%2F',
  });
});

// Each case protects URL validation/encoding or the absence of unrelated account data.
test('URL preserves the original path, query and fragment with one level of encoding', () => {
  const result = youtube.buildSignInUrl(
    { authuser: 0, pageid: '12345678901234567890' },
    '/watch?v=a%2Fb&list=one two#ไทย',
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const url = new URL(result.value);
  expect(url.origin + url.pathname).toBe('https://www.youtube.com/signin');
  expect(url.searchParams.get('authuser')).toBe('0');
  expect(url.searchParams.get('pageid')).toBe('12345678901234567890');
  expect(url.searchParams.get('next')).toBe('/watch?v=a%2Fb&list=one two#ไทย');
  expect([...url.searchParams.keys()]).toEqual([
    'action_handle_signin',
    'authuser',
    'pageid',
    'next',
  ]);
});

test.each([
  '//evil.example/watch',
  '/\\evil.example',
  'javascript:alert(1)',
  '',
  'watch',
  'https://www.youtube.com/watch',
  '/%2f%2fevil.example',
  '/%5cevil.example',
  '/watch\n?x=1',
  '/%252f%252fevil.example',
  '/%ZZ',
])('unsafe next %j falls back to root', (next) => {
  const result = youtube.buildSignInUrl({ authuser: 1 }, next);
  expect(result.ok && new URL(result.value).searchParams.get('next')).toBe('/');
});

test.each([
  { authuser: -1 },
  { authuser: 1.5 },
  { authuser: NaN },
  { authuser: Infinity },
  { authuser: Number.MAX_SAFE_INTEGER + 1 },
  { authuser: 0, pageid: '' },
  { authuser: 0, pageid: '1&next=evil' },
  { authuser: 0, pageid: 'abc' },
])('invalid saved session %j is rejected', (session) => {
  expect(youtube.buildSignInUrl(session, '/')).toEqual({ ok: false, error: 'invalid_session' });
});

const activeTab = {
  id: 7,
  active: true,
  url: 'https://www.youtube.com/watch?v=abc&list=def#t=2',
  status: 'complete',
};

test('read returns only the two allowed coordinates from the serialized MAIN function', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  expect(await youtube.readSession(deps, 7)).toEqual({
    ok: true,
    value: { authuser: 2, pageid: '12345' },
  });
  expect(state.keys).toEqual(['SESSION_INDEX', 'DELEGATED_SESSION_ID']);
});

test.each([undefined, null, ''])('personal account omits pageid %j', async (pageid) => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.data = { SESSION_INDEX: 0, DELEGATED_SESSION_ID: pageid };
  expect(await youtube.readSession(deps, 7)).toEqual({ ok: true, value: { authuser: 0 } });
});

test.each([undefined, null, '', ' 2', '-1', '1.1', '1e2', {}, false, -1, 1.5, Infinity])(
  'malformed authuser %j returns not_signed_in',
  async (authuser) => {
    const { deps, state } = fakeYouTube([activeTab]);
    state.data.SESSION_INDEX = authuser;
    expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'not_signed_in' });
  },
);

test.each([{}, false, 12, 'abc'])('malformed pageid %j returns not_signed_in', async (pageid) => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.data.DELEGATED_SESSION_ID = pageid;
  expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'not_signed_in' });
});

test.each(['missingConfig', 'throwConfig', 'emptyResult'] as const)(
  'missing/unavailable ytcfg: %s',
  async (key) => {
    const { deps, state } = fakeYouTube([activeTab]);
    state[key] = true;
    expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'not_signed_in' });
  },
);

test.each([
  'https://evil.example',
  'https://youtube.com.evil.example',
  'file:///youtube.com',
  'not-url',
  undefined,
])('reject non-YouTube tab %j without injecting', async (url) => {
  const { deps, state } = fakeYouTube([{ id: 7, ...(url ? { url } : {}) }]);
  expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'invalid_tab' });
  expect(state.calls).not.toContain('script');
});

test.each(['get', 'script'])('read API rejection %s never escapes as a throw', async (op) => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.fail = op;
  expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'api_error' });
});

test.each([{ authuser: '2' }, { authuser: 2, pageid: {} }, false, 'private'])(
  'invalid injection result %j is rejected',
  async (value) => {
    const { deps, state } = fakeYouTube([activeTab]);
    state.resultOverride = value;
    expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'not_signed_in' });
  },
);

test('switch selects active YouTube, verifies before reloading peers and preserves next', async () => {
  const { deps, state } = fakeYouTube([
    { id: 1, active: false, url: 'https://m.youtube.com/' },
    activeTab,
    { id: 3, active: true, url: 'https://other.example' },
  ]);
  expect(await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
    ok: true,
    value: { tabId: 7, reloadedTabs: 1 },
  });
  const url = new URL(state.tabs.get(7)?.url ?? '');
  expect(url.searchParams.get('next')).toBe('/watch?v=abc&list=def#t=2');
  expect(state.calls.indexOf('script')).toBeLessThan(state.calls.indexOf('reload:1'));
  expect(state.calls).not.toContain('reload:3');
  expect(state.listeners.size).toBe(0);
});

test('switch creates a YouTube tab when there are no YouTube tabs', async () => {
  const { deps, state } = fakeYouTube([{ id: 1, url: 'https://other.example' }]);
  expect(await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
    ok: true,
    value: { tabId: 99, reloadedTabs: 0 },
  });
  expect(state.tabs.get(99)?.active).toBe(true);
  expect(new URL(state.tabs.get(99)?.url ?? '').searchParams.get('next')).toBe('/');
});

test('switch uses an existing inactive YouTube tab when no YouTube tab is active', async () => {
  const { deps, state } = fakeYouTube([{ ...activeTab, active: false }]);
  expect((await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).ok).toBe(true);
  expect(state.calls).toContain('update');
  expect(state.tabs.get(7)?.active).toBe(true);
});

test.each([{ authuser: 1, pageid: '12345' }, { authuser: 2, pageid: '67890' }, { authuser: 2 }])(
  'verify detects shifted authuser or changed channel %j',
  async (session) => {
    const { deps, state } = fakeYouTube([activeTab, { ...activeTab, id: 8 }]);
    expect(await youtube.switchAccount(deps, session)).toEqual({
      ok: false,
      error: 'not_signed_in',
    });
    expect(state.calls).not.toContain('reload:8');
  },
);

test('switch waits for complete before reading ytcfg, ignores unrelated/loading events, cleans listener', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.loading = true;
  const pending = youtube.switchAccount(
    { ...deps, loadTimeoutMs: 500 },
    { authuser: 2, pageid: '12345' },
  );
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(state.calls).not.toContain('script');
  const signin = state.tabs.get(7)?.url;
  for (const listener of state.listeners) {
    listener(8, { status: 'complete' }, { id: 8 });
    listener(7, { status: 'loading', url: signin }, { id: 7 });
  }
  expect(state.calls).not.toContain('script');
  state.finish(7);
  expect((await pending).ok).toBe(true);
  expect(state.listeners.size).toBe(0);
});

test('load timeout returns api_error and removes the listener', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.loading = true;
  expect(await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
    ok: false,
    error: 'api_error',
  });
  expect(state.listeners.size).toBe(0);
  expect(state.calls).not.toContain('script');
});

test.each(['query', 'update', 'listen', 'get', 'script'])(
  'switch API failure %s is a Result',
  async (op) => {
    const { deps, state } = fakeYouTube([activeTab, { ...activeTab, id: 8 }]);
    state.fail = op;
    expect(await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
      ok: false,
      error: 'api_error',
    });
    expect(state.listeners.size).toBe(0);
  },
);

test('a YouTube tab closed during the switch is skipped; the switch still worked', async () => {
  const { deps, state } = fakeYouTube([
    activeTab,
    { ...activeTab, id: 8, active: false },
    { ...activeTab, id: 9, active: false },
  ]);
  state.fail = 'reload:8';
  expect(await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
    ok: true,
    value: { tabId: 7, reloadedTabs: 1 },
  });
  expect(state.calls).toContain('reload:9');
  expect(state.listeners.size).toBe(0);
});

test('create failure is a Result', async () => {
  const { deps, state } = fakeYouTube();
  state.fail = 'create';
  expect(await youtube.switchAccount(deps, { authuser: 0 })).toEqual({
    ok: false,
    error: 'api_error',
  });
});

test('invalid target never navigates or queries', async () => {
  const { deps, state } = fakeYouTube();
  expect(await youtube.switchAccount(deps, { authuser: -1 })).toEqual({
    ok: false,
    error: 'invalid_session',
  });
  expect(state.calls).toEqual([]);
});

test('the MAIN script also works serialized in an isolated page with no module closure', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.serialized = true;
  expect(await youtube.readSession(deps, 7)).toEqual({
    ok: true,
    value: { authuser: 2, pageid: '12345' },
  });
});

test('verify accepts a personal account with authuser zero and no pageid', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.data = { SESSION_INDEX: '0' };
  expect(await youtube.verifySession(deps, 7, { authuser: 0 })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await youtube.verifySession(deps, 7, { authuser: -1 })).toEqual({
    ok: false,
    error: 'invalid_session',
  });
});

test('switch returns not_signed_in when ytcfg disappears after navigation', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.missingConfig = true;
  expect(await youtube.switchAccount(deps, { authuser: 2 })).toEqual({
    ok: false,
    error: 'not_signed_in',
  });
});

test('read strips unexpected page properties from injection results', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  state.resultOverride = { authuser: 2, pageid: '12345', email: 'private' };
  expect(await youtube.readSession(deps, 7)).toEqual({
    ok: true,
    value: { authuser: 2, pageid: '12345' },
  });
  state.resultOverride = { authuser: 2, email: 'private' };
  expect(await youtube.readSession(deps, 7)).toEqual({ ok: true, value: { authuser: 2 } });
});

test('missing tab id from navigation returns invalid_tab', async () => {
  const { deps } = fakeYouTube();
  deps.tabs.create = async () => ({});
  expect(await youtube.switchAccount(deps, { authuser: 0 })).toEqual({
    ok: false,
    error: 'invalid_tab',
  });
  deps.tabs.create = async () => ({ id: 99, url: 'https://www.youtube.com/' });
  deps.tabs.query = async () => [activeTab];
  deps.tabs.update = async () => undefined;
  expect(await youtube.switchAccount(deps, { authuser: 0 })).toEqual({
    ok: false,
    error: 'invalid_tab',
  });
});

test('standalone read propagates no browser failures outside the Result boundary', async () => {
  const { deps } = fakeYouTube([activeTab]);
  expect(await youtube.readSession(deps, -1)).toEqual({ ok: false, error: 'api_error' });
});

test('tab with no id is never injected or reloaded', async () => {
  const { deps, state } = fakeYouTube([{ url: 'https://youtube.com/', active: true }]);
  expect(await youtube.switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
    ok: true,
    value: { tabId: 99, reloadedTabs: 0 },
  });
  expect(state.calls).not.toContain('update');
});

test.each(['https://name:pass@youtube.com/', 'https://youtube.com:444/', 'ftp://youtube.com/'])(
  'read rejects unsupported tab URL %s',
  async (url) => {
    const { deps } = fakeYouTube([{ ...activeTab, url }]);
    expect(await youtube.readSession(deps, 7)).toEqual({ ok: false, error: 'invalid_tab' });
  },
);

test.each([
  '/watch?q=100%25',
  '/%25',
  '/channel/a%20b',
  '/watch?redirect=https%3A%2F%2Fexample.com',
])('valid encoded path/query %s keeps its original spelling', (next) => {
  const result = youtube.buildSignInUrl({ authuser: 0 }, next);
  expect(result.ok && new URL(result.value).searchParams.get('next')).toBe(next);
});

test.each(['/%252fevil.example?x=%25', '/%255cevil.example?x=%25'])(
  'literal query percent cannot hide an encoded redirect %s',
  (next) => {
    const result = youtube.buildSignInUrl({ authuser: 0 }, next);
    expect(result.ok && new URL(result.value).searchParams.get('next')).toBe('/');
  },
);

test('an old complete document cannot satisfy a navigation that has not started yet', async () => {
  const { deps, state } = fakeYouTube([activeTab]);
  deps.tabs.update = async () => ({ ...activeTab });
  const pending = youtube.switchAccount(
    { ...deps, loadTimeoutMs: 500 },
    { authuser: 2, pageid: '12345' },
  );
  for (let i = 0; i < 15; i++) await Promise.resolve();
  const readOldPage = state.calls.includes('script');
  // The signin page redirected straight back to `next`, so Chrome reports that URL, not /signin.
  for (const listener of state.listeners)
    listener(7, { status: 'loading', url: activeTab.url }, activeTab);
  state.finish(7);
  const result = await pending;
  expect(readOldPage).toBe(false);
  expect(result.ok).toBe(true);
  expect(state.listeners.size).toBe(0);
});
