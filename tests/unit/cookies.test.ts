// docs/design.md 8.3 tests 1–3, plus "no cookie values in the console" (design 6).
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  clear,
  cookieUrl,
  currentUserId,
  restore,
  type StoredCookie,
  snapshot,
} from '../../src/lib/cookies';
import type { CookieSetDetails } from '../../src/lib/ports';
import { type FakeChrome, fakeChrome } from '../fakes/chrome';
import { facebook, instagram } from '../fakes/platforms';

const NOW = Date.UTC(2026, 0, 1);
const inDays = (days: number) => NOW / 1000 + days * 86400;
const base = { path: '/', secure: true, httpOnly: false, sameSite: 'lax' } as const;

/** Signs a fake Facebook user in, with device cookies and one CHIPS cookie, plus an unrelated site. */
async function seed(chrome: FakeChrome, user = '1001') {
  const set = (d: Partial<CookieSetDetails> & Pick<CookieSetDetails, 'name' | 'value'>) =>
    chrome.cookies.set({ url: 'https://www.facebook.com/', ...base, ...d });
  await set({ name: 'c_user', value: user, domain: 'facebook.com', expirationDate: inDays(90) });
  await set({
    name: 'xs',
    value: `xs-secret-${user}`,
    domain: 'facebook.com',
    httpOnly: true,
    sameSite: 'no_restriction',
    expirationDate: inDays(90),
  });
  await set({ name: 'presence', value: 'p', domain: 'facebook.com' }); // session cookie
  await set({ name: 'host_only', value: 'h' }); // www.facebook.com only
  await set({ name: 'strict_one', value: 's', domain: 'facebook.com', sameSite: 'strict' });
  await set({
    name: 'chips',
    value: 'c',
    sameSite: 'no_restriction',
    partitionKey: { topLevelSite: 'https://instagram.com' },
  });
  await set({
    name: 'datr',
    value: 'device-datr',
    domain: 'facebook.com',
    expirationDate: inDays(400),
  });
  await set({ name: 'sb', value: 'device-sb', domain: 'facebook.com' });
  await chrome.cookies.set({
    url: 'https://m.facebook.com/',
    name: 'm_only',
    value: 'm',
    ...base,
    path: '/x',
  });
  await chrome.cookies.set({
    url: 'https://www.instagram.com/',
    name: 'sessionid',
    value: 'ig-secret',
    ...base,
    domain: 'instagram.com',
  });
  await chrome.cookies.set({
    url: 'https://notfacebook.com/',
    name: 'c_user',
    value: 'impostor',
    ...base,
    domain: 'notfacebook.com',
  });
}

let chrome: FakeChrome;
beforeEach(async () => {
  chrome = fakeChrome({ now: NOW });
  await seed(chrome);
});

const byName = (list: { name: string }[]) => list.map((c) => c.name).sort();

describe('snapshot (test 1)', () => {
  test('keeps session cookies of the platform and drops its device cookies', async () => {
    const got = await snapshot(chrome.cookies, facebook);
    expect(byName(got)).toEqual([
      'c_user',
      'chips',
      'host_only',
      'm_only',
      'presence',
      'strict_one',
      'xs',
    ]);
  });

  test('never includes another domain', async () => {
    const got = await snapshot(chrome.cookies, facebook);
    expect(
      got.every((c) => c.domain.endsWith('facebook.com') && !c.domain.includes('notfacebook')),
    ).toBe(true);
    expect(byName(await snapshot(chrome.cookies, instagram))).toEqual(['sessionid']);
  });

  test("uses each platform's own denylist", async () => {
    await chrome.cookies.set({
      url: 'https://www.instagram.com/',
      name: 'mid',
      value: 'device',
      ...base,
      domain: 'instagram.com',
    });
    await chrome.cookies.set({
      url: 'https://www.instagram.com/',
      name: 'datr',
      value: 'device',
      ...base,
      domain: 'instagram.com',
    });
    await chrome.cookies.set({
      url: 'https://www.instagram.com/',
      name: 'sb',
      value: 'kept-on-ig',
      ...base,
      domain: 'instagram.com',
    });
    expect(byName(await snapshot(chrome.cookies, instagram))).toEqual(['sb', 'sessionid']);
  });

  test('stores what restore needs and nothing Chrome-specific', async () => {
    const got = await snapshot(chrome.cookies, facebook);
    const xs = got.find((c) => c.name === 'xs');
    expect(xs).toEqual({
      name: 'xs',
      value: 'xs-secret-1001',
      domain: '.facebook.com',
      path: '/',
      hostOnly: false,
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: inDays(90),
    });
    expect(got.find((c) => c.name === 'presence')).not.toHaveProperty('expirationDate');
    expect(got.find((c) => c.name === 'chips')?.partitionKey).toEqual({
      topLevelSite: 'https://instagram.com',
      hasCrossSiteAncestor: true,
    });
    expect(got.find((c) => c.name === 'host_only')).toMatchObject({
      hostOnly: true,
      domain: 'www.facebook.com',
    });
  });
});

describe('restore (test 2)', () => {
  const restoreInto = async (cookies: StoredCookie[], now = NOW) => {
    const target = fakeChrome({ now });
    const result = await restore(target.cookies, cookies, now);
    return { target, result };
  };

  test('puts back exactly what snapshot saw', async () => {
    const saved = await snapshot(chrome.cookies, facebook);
    const { target, result } = await restoreInto(saved);
    expect(result).toEqual({ ok: true, value: saved.length });
    expect(await snapshot(target.cookies, facebook)).toEqual(saved);
  });

  test('a host-only cookie is set without `domain` and stays host-only', async () => {
    const saved = await snapshot(chrome.cookies, facebook);
    const spy = fakeChrome({ now: NOW });
    const calls: CookieSetDetails[] = [];
    const original = spy.cookies.set;
    spy.cookies.set = (d) => {
      calls.push(d);
      return original(d);
    };
    await restore(spy.cookies, saved, NOW);
    const hostOnly = calls.find((d) => d.name === 'host_only');
    expect(hostOnly).not.toHaveProperty('domain');
    expect(hostOnly?.url).toBe('https://www.facebook.com/');
    expect(calls.find((d) => d.name === 'xs')?.domain).toBe('.facebook.com');
    expect(spy.cookies.all().find((c) => c.name === 'host_only')).toMatchObject({
      hostOnly: true,
      domain: 'www.facebook.com',
    });
  });

  test('skips expired cookies and keeps the rest', async () => {
    const saved = await snapshot(chrome.cookies, facebook);
    const later = NOW + 100 * 86400 * 1000; // c_user and xs expired after 90 days
    const { target, result } = await restoreInto(saved, later);
    expect(result).toEqual({ ok: true, value: saved.length - 2 });
    expect(byName(target.cookies.all())).not.toContain('xs');
  });

  test('every cookie expired gives all_expired and sets nothing', async () => {
    const expired = (await snapshot(chrome.cookies, facebook)).map((c) => ({
      ...c,
      expirationDate: inDays(-1),
    }));
    const { target, result } = await restoreInto(expired);
    expect(result).toEqual({ ok: false, error: 'all_expired' });
    expect(target.cookies.all()).toEqual([]);
  });

  test('an empty list is not all_expired', async () => {
    expect((await restoreInto([])).result).toEqual({ ok: true, value: 0 });
  });

  test('keeps partitionKey and the right sameSite', async () => {
    const saved = await snapshot(chrome.cookies, facebook);
    const { target } = await restoreInto(saved);
    const after = target.cookies.all();
    expect(after.find((c) => c.name === 'chips')?.partitionKey).toEqual({
      topLevelSite: 'https://instagram.com',
      hasCrossSiteAncestor: true,
    });
    expect(Object.fromEntries(after.map((c) => [c.name, c.sameSite]))).toMatchObject({
      xs: 'no_restriction',
      strict_one: 'strict',
      c_user: 'lax',
      chips: 'no_restriction',
    });
  });

  test('a cookie Chrome rejects counts as not set instead of throwing', async () => {
    const bad: StoredCookie = {
      name: 'x',
      value: 'v',
      domain: '.facebook.com',
      path: '/',
      hostOnly: false,
      secure: false,
      httpOnly: false,
      sameSite: 'no_restriction',
    };
    const good: StoredCookie = { ...bad, name: 'y', sameSite: 'lax' };
    expect((await restoreInto([bad, good])).result).toEqual({ ok: true, value: 1 });
  });
});

describe('clear (test 3)', () => {
  test('builds the URL from secure, domain and path', () => {
    expect(cookieUrl({ secure: true, domain: '.facebook.com', path: '/' })).toBe(
      'https://facebook.com/',
    );
    expect(cookieUrl({ secure: false, domain: 'm.facebook.com', path: '/x' })).toBe(
      'http://m.facebook.com/x',
    );
  });

  test('removes every session cookie, partitioned ones included, and leaves device cookies', async () => {
    await chrome.cookies.set({
      url: 'http://web.facebook.com/a',
      name: 'plain_http',
      value: 'v',
      path: '/a',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
    });
    const removed = await clear(chrome.cookies, facebook);
    expect(removed).toBe(8);
    expect(byName(await snapshot(chrome.cookies, facebook))).toEqual([]);
    const left = chrome.cookies
      .all()
      .map((c) => `${c.name}@${c.domain}`)
      .sort();
    expect(left).toEqual([
      'c_user@.notfacebook.com',
      'datr@.facebook.com',
      'sb@.facebook.com',
      'sessionid@.instagram.com',
    ]);
    const urls = Object.fromEntries(chrome.cookies.removeCalls.map((d) => [d.name, d.url]));
    expect(urls).toMatchObject({
      xs: 'https://facebook.com/',
      host_only: 'https://www.facebook.com/',
      m_only: 'https://m.facebook.com/x',
      plain_http: 'http://web.facebook.com/a',
    });
    expect(chrome.cookies.removeCalls.find((d) => d.name === 'chips')?.partitionKey).toEqual({
      topLevelSite: 'https://instagram.com',
      hasCrossSiteAncestor: true,
    });
  });

  test('counts only cookies that are really gone', async () => {
    chrome.cookies.remove = async (d) => ({ url: d.url, name: d.name }); // resolves, deletes nothing
    expect(await clear(chrome.cookies, facebook)).toBe(0);
    chrome.cookies.remove = () => Promise.reject(new Error('boom'));
    expect(await clear(chrome.cookies, facebook)).toBe(0);
  });
});

test('the test platforms recognise checkpoint pages', () => {
  expect(facebook.isCheckpointUrl('https://www.facebook.com/checkpoint/123/')).toBe(true);
  expect(instagram.isCheckpointUrl('https://www.instagram.com/challenge/x/')).toBe(true);
  expect(facebook.isCheckpointUrl('https://www.facebook.com/home')).toBe(false);
});

describe('currentUserId', () => {
  test('reads the platform ID cookie and ignores look-alike domains', async () => {
    expect(await currentUserId(chrome.cookies, facebook)).toBe('1001');
    await clear(chrome.cookies, facebook);
    expect(await currentUserId(chrome.cookies, facebook)).toBeNull();
  });

  test('null when the ID cookie is empty', async () => {
    await chrome.cookies.set({
      url: 'https://www.instagram.com/',
      name: 'ds_user_id',
      value: '',
      ...base,
      domain: 'instagram.com',
    });
    expect(await currentUserId(chrome.cookies, instagram)).toBeNull();
  });
});

describe('cookie values never reach the console', () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const calls = mock();
  beforeEach(() => {
    for (const m of methods) console[m] = calls;
  });
  afterEach(() => {
    for (const m of methods) console[m] = originals[m] as never;
    calls.mockClear();
  });

  test('snapshot, clear, restore and currentUserId print nothing, even on failures', async () => {
    const saved = await snapshot(chrome.cookies, facebook);
    await currentUserId(chrome.cookies, facebook);
    await clear(chrome.cookies, facebook);
    await restore(chrome.cookies, saved, NOW);
    chrome.cookies.set = () => Promise.reject(new Error('rejected'));
    await restore(chrome.cookies, saved, NOW);
    expect(calls).not.toHaveBeenCalled();
  });
});
