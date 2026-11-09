// QC t-539: the switch waits for the navigation it asked for (cases A to G of the QC probe, all on
// the target tab), and `next` costs linear time however it is encoded. docs/design.md 3.3.
import { expect, test } from 'bun:test';
import {
  buildSignInUrl,
  MAX_NEXT_LENGTH,
  switchAccount,
} from '../../src/background/platforms/youtube';
import type { TabUpdateInfo } from '../../src/lib/ports';
import { fakeYouTube } from '../fakes/youtube';

const want = { authuser: 2, pageid: '12345' };
const OLD = 'https://www.youtube.com/watch?v=old';
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** Tab 7 is active on OLD; update() leaves it loading and says nothing, like Chrome before commit. */
function setup(sessionIndex = '2') {
  const f = fakeYouTube([
    { id: 7, active: true, url: OLD, status: 'complete' },
    { id: 8, url: 'https://www.youtube.com/watch?v=other', status: 'complete' },
  ]);
  f.state.loading = true;
  f.state.data.SESSION_INDEX = sessionIndex;
  const tab = () => {
    const t = f.state.tabs.get(7);
    if (!t) throw new Error('no tab 7');
    return t;
  };
  const fire = (change: TabUpdateInfo) => {
    if (change.url !== undefined) tab().url = change.url;
    if (change.status !== undefined) tab().status = change.status;
    for (const l of f.state.listeners) l(7, change, { ...tab() });
  };
  /** One navigation of tab 7: loading (with a URL when given), then complete. */
  const navigate = (url?: string) => {
    fire(url === undefined ? { status: 'loading' } : { status: 'loading', url });
    fire({ status: 'complete' });
  };
  const start = (timeout = 300) => switchAccount({ ...f.deps, loadTimeoutMs: timeout }, want);
  return { ...f, tab, fire, navigate, start };
}

test('A: the requested signin navigation loads, then the page is read and the other tab reloaded', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  const signin = s.tab().url ?? '';
  expect(signin).toStartWith('https://www.youtube.com/signin?');
  s.navigate(signin);
  expect(await pending).toEqual({ ok: true, value: { tabId: 7, reloadedTabs: 1 } });
  expect(s.state.calls.indexOf('script')).toBeLessThan(s.state.calls.indexOf('reload:8'));
});

test('same-URL 302: signin sends the tab back to the URL it had, so Chrome sends no url', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  s.tab().url = OLD; // committed again; the URL did not change, so onUpdated has none
  s.navigate();
  expect(await pending).toEqual({ ok: true, value: { tabId: 7, reloadedTabs: 1 } });
});

test('302 to `next` with an extra query parameter still counts (only the path is compared)', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  s.navigate(`${OLD}&feature=signin`);
  expect((await pending).ok).toBe(true);
});

test('B: another path loading on the target tab neither ends the wait nor gets read', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  s.navigate('https://www.youtube.com/feed/trending');
  await settle();
  expect(s.state.calls).not.toContain('script');
  // The requested navigation still counts when it arrives.
  s.navigate(OLD);
  expect(await pending).toEqual({ ok: true, value: { tabId: 7, reloadedTabs: 1 } });
});

test('B2: with only the other navigation, the switch times out without reading or reloading', async () => {
  const s = setup();
  const pending = s.start(60);
  await settle();
  s.navigate('https://www.youtube.com/feed/trending');
  expect(await pending).toEqual({ ok: false, error: 'api_error' });
  expect(s.state.calls).not.toContain('script');
  expect(s.state.calls).not.toContain('reload:8');
  expect(s.state.listeners.size).toBe(0);
});

test('C: a page still showing the old account is never judged not_signed_in while waiting', async () => {
  const s = setup('0');
  const pending = s.start(60);
  await settle();
  s.navigate('https://www.youtube.com/feed/trending');
  expect(await pending).toEqual({ ok: false, error: 'api_error' });
  expect(s.state.calls).not.toContain('script');
});

test('C2: another video on the same path is not told apart; reading ytcfg is what decides', async () => {
  const s = setup('0');
  const pending = s.start();
  await settle();
  s.navigate('https://www.youtube.com/watch?v=unrelated');
  expect(await pending).toEqual({ ok: false, error: 'not_signed_in' });
  expect(s.state.calls).not.toContain('reload:8');
});

test('another YouTube tab loading meanwhile neither ends the wait nor gets read or reloaded instead', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  // Tab 8 reloads by itself while the switch waits for tab 7.
  const other = s.state.tabs.get(8);
  for (const change of [{ status: 'loading' }, { status: 'complete' }]) {
    for (const l of s.state.listeners) l(8, change, { ...other });
  }
  await settle();
  expect(s.state.calls).not.toContain('script');
  expect(s.state.listeners.size).toBe(1);
  // The target tab then loads: it is the one read, and tab 8 is the one reloaded.
  s.navigate();
  expect(await pending).toEqual({ ok: true, value: { tabId: 7, reloadedTabs: 1 } });
  expect(s.state.calls.filter((c) => c === 'script')).toHaveLength(1);
  expect(s.state.calls).toContain('reload:8');
  expect(s.state.calls).not.toContain('reload:7');
});

test('D: a load that started before update() resolved is not the requested one', async () => {
  const s = setup();
  const update = s.deps.tabs.update;
  s.deps.tabs.update = async (id, options) => {
    s.fire({ status: 'loading' }); // the old page reloading itself
    return update(id, options);
  };
  const pending = s.start(60);
  await settle();
  s.fire({ status: 'complete' });
  expect(await pending).toEqual({ ok: false, error: 'api_error' });
  expect(s.state.calls).not.toContain('script');
});

test('D2: Chrome can repeat loading; the next complete still ends the wait', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  s.fire({ status: 'loading' });
  s.navigate();
  expect((await pending).ok).toBe(true);
});

test('E: Google sends the tab to its login page, whose URL Chrome hides: not_signed_in', async () => {
  const s = setup();
  const pending = s.start();
  await settle();
  // No google.com permission: no url in onUpdated, and tab.url is undefined.
  s.tab().url = undefined;
  s.fire({ status: 'loading' });
  s.fire({});
  s.fire({ status: 'complete' });
  expect(await pending).toEqual({ ok: false, error: 'not_signed_in' });
  expect(s.state.calls).not.toContain('script');
  expect(s.state.calls).not.toContain('reload:8');
});

test("E2: a visible page that is not YouTube is someone else's navigation", async () => {
  const s = setup();
  const pending = s.start(60);
  await settle();
  s.navigate('https://www.facebook.com/');
  expect(await pending).toEqual({ ok: false, error: 'api_error' });
});

test('F: a complete for the old document, before any load, is ignored', async () => {
  const s = setup();
  s.deps.tabs.update = async (id) => {
    s.state.calls.push('update');
    return { ...s.state.tabs.get(id) };
  };
  const pending = s.start(60);
  await settle();
  s.fire({ status: 'complete' });
  await settle();
  expect(s.state.calls).not.toContain('script');
  expect(await pending).toEqual({ ok: false, error: 'api_error' });
});

test('a landing-URL load that happens before update() resolves is not counted', async () => {
  const s = setup();
  const update = s.deps.tabs.update;
  s.deps.tabs.update = async (id, options) => {
    s.navigate(OLD); // someone else's navigation, finished before ours was even accepted
    return update(id, options);
  };
  expect(await s.start(60)).toEqual({ ok: false, error: 'api_error' });
  expect(s.state.calls).not.toContain('script');
});

test('the signin URL itself counts even before update() resolves (it is unique to this switch)', async () => {
  const s = setup();
  const update = s.deps.tabs.update;
  s.deps.tabs.update = async (id, options) => {
    const tab = await update(id, options);
    s.fire({ status: 'loading', url: options.url });
    return tab;
  };
  const pending = s.start();
  await settle();
  s.fire({ status: 'complete' });
  expect((await pending).ok).toBe(true);
});

// --- `next`: bounded cost, still no way off youtube.com ---

const nextOf = (path: string) => {
  const built = buildSignInUrl({ authuser: 0 }, path);
  if (!built.ok) throw new Error(built.error);
  return new URL(built.value).searchParams.get('next');
};

test('2 MB of nested %25 is refused in well under 50 ms', () => {
  const input = `/%${'25'.repeat(1_000_000)}2F%2Fevil.example`;
  expect(input.length).toBeGreaterThan(2_000_000);
  const started = performance.now();
  expect(nextOf(input)).toBe('/');
  expect(performance.now() - started).toBeLessThan(50);
});

test('nested %25 just under the length cap also stays fast', () => {
  const input = `/%${'25'.repeat(1000)}2F%2Fevil`;
  expect(input.length).toBeLessThanOrEqual(MAX_NEXT_LENGTH);
  const started = performance.now();
  expect(nextOf(input)).toBe('/');
  expect(performance.now() - started).toBeLessThan(50);
});

test('the length cap is 2048 characters', () => {
  const ok = `/${'a'.repeat(MAX_NEXT_LENGTH - 1)}`;
  expect(nextOf(ok)).toBe(ok);
  expect(nextOf(`${ok}a`)).toBe('/');
});

test('three layers of encoding are looked through; a fourth is refused', () => {
  expect(nextOf('/x%252525')).toBe('/x%252525');
  expect(nextOf('/x%25252525')).toBe('/');
  expect(nextOf('/a%2520b')).toBe('/a%2520b');
});

// The vectors of the t-539 QC probe (probe-redirect.ts, copied as they are; the report counts 57,
// the list holds 56): none may leave youtube.com, raw or decoded once or twice.
const VECTORS = [
  '//evil.example',
  '/\\evil.example',
  '\\\\evil.example',
  '/\\/evil.example',
  '//\\evil.example',
  '/%2F%2Fevil.example',
  '/%2f%2fevil.example',
  '/%5Cevil.example',
  '/%5c%5cevil.example',
  '/%252F%252Fevil.example',
  '/%252F%2Fevil.example',
  '/%2F%252Fevil.example',
  '/%25252F%25252Fevil.example',
  '/%25%2F%2Fevil.example',
  '/%2525%252F%252Fevil.example',
  'javascript:alert(1)',
  'data:text/html,x',
  'https://evil.example',
  'https:evil.example',
  'http://evil.example',
  'evil.example',
  '',
  '/',
  '/%',
  '/%2',
  '/%ZZ',
  '/%c0%af%c0%afevil',
  '/%ef%bc%8f%ef%bc%8fevil',
  '/％２Ｆ％２Ｆevil',
  '/\u0000//evil',
  '/%00//evil',
  '/%09//evil',
  '/\t//evil',
  '/%0d%0a//evil',
  '/ //evil',
  '/%20//evil',
  '/./%2F/evil',
  '/..//evil.example',
  '/%2e%2e%2f%2fevil',
  '/@evil.example',
  '/evil.example',
  '/;//evil.example',
  '/ //evil',
  '/​//evil',
  '/‮//evil',
  '/watch?next=//evil.example',
  '/watch#//evil.example',
  '/watch?v=a%2Fb&list=x#t=1',
  '/%25',
  '/channel/a%20b',
  '/%u002F%u002Fevil',
  '/%E0%80%AFevil',
  '/%252fevil.example?x=%25',
  '/%2F%2Fevil.example?x=%25',
  '/日本語/ทดสอบ',
  `/${'a'.repeat(20000)}`,
];

test('none of the QC vectors leaves youtube.com', () => {
  expect(VECTORS).toHaveLength(56);
  const decode = (x: string) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  };
  const origin = (x: string) => {
    try {
      return new URL(x, 'https://www.youtube.com/signin').origin;
    } catch {
      return 'INVALID';
    }
  };
  for (const vector of VECTORS) {
    const next = nextOf(vector) ?? '';
    for (const form of [next, decode(next), decode(decode(next))]) {
      expect(origin(form)).toBe('https://www.youtube.com');
    }
  }
});
