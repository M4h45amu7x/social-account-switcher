// The fakes are only useful if they behave like Chrome, so their rules get tests too.
import { describe, expect, test } from 'bun:test';
import type { CookieSetDetails } from '../../src/lib/ports';
import { fakeChrome, fakeCookies, matchesPattern } from '../fakes/chrome';

const d = (over: Partial<CookieSetDetails> = {}): CookieSetDetails => ({
  url: 'https://www.facebook.com/',
  name: 'n',
  value: 'v',
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'lax',
  ...over,
});

describe('fake cookies', () => {
  test('rejects what Chrome rejects', async () => {
    const c = fakeCookies();
    for (const bad of [
      d({ url: 'not a url' }),
      d({ url: 'ftp://www.facebook.com/' }),
      d({ domain: 'instagram.com' }),
      d({ url: 'http://www.facebook.com/' }),
      d({ secure: false, sameSite: 'no_restriction' }),
      d({
        secure: false,
        url: 'http://www.facebook.com/',
        partitionKey: { topLevelSite: 'https://x.com' },
      }),
      d({ name: '__Secure-a', secure: false, url: 'http://www.facebook.com/' }),
      d({ name: '__Host-a', domain: 'facebook.com' }),
      d({ name: '__Host-a', path: '/x' }),
    ]) {
      await expect(c.set(bad)).rejects.toThrow();
    }
    expect(c.all()).toEqual([]);
  });

  test('host-only vs domain cookies, replacement and expiry', async () => {
    const clock = { now: 1_000_000 };
    const c = fakeCookies(clock);
    expect(await c.set(d())).toMatchObject({
      domain: 'www.facebook.com',
      hostOnly: true,
      session: true,
    });
    expect(await c.set(d({ domain: '.facebook.com', value: 'w' }))).toMatchObject({
      domain: '.facebook.com',
      hostOnly: false,
    });
    await c.set(d({ value: 'replaced' }));
    expect(
      c
        .all()
        .map((x) => x.value)
        .sort(),
    ).toEqual(['replaced', 'w']);
    await c.set(d({ name: '__Host-ok', expirationDate: 2000 }));
    expect(c.all()).toHaveLength(3);
    clock.now = 2_000_000; // expirationDate is in seconds
    expect(c.all()).toHaveLength(2);
    expect(await c.set(d({ expirationDate: 1 }))).toBeNull(); // setting an expired cookie deletes it
    expect(c.all().map((x) => x.value)).toEqual(['w']);
  });

  test('path defaults to the URL directory and remove() matches paths and schemes', async () => {
    const c = fakeCookies();
    const { path: _p, ...noPath } = d({ url: 'http://m.facebook.com/a/b', secure: false });
    expect(await c.set(noPath as CookieSetDetails)).toMatchObject({ path: '/a' });
    await c.set(d({ name: 's', url: 'https://m.facebook.com/' }));
    await c.remove({ url: 'http://m.facebook.com/ab', name: 'n' });
    await c.remove({ url: 'http://m.facebook.com/', name: 's' }); // secure cookie, http URL
    expect(c.all()).toHaveLength(2);
    await c.remove({ url: 'http://m.facebook.com/a/deeper', name: 'n' });
    await c.remove({ url: 'https://m.facebook.com/', name: 's' });
    expect(c.all()).toEqual([]);
  });

  test('partition rules match Chromium', async () => {
    const c = fakeCookies();
    await c.set(d({ name: 'plain' }));
    await c.set(
      d({
        name: 'part',
        sameSite: 'no_restriction',
        partitionKey: { topLevelSite: 'https://instagram.com' },
      }),
    );
    await c.set(d({ name: 'same', partitionKey: { topLevelSite: 'https://facebook.com' } }));
    const names = async (k?: { topLevelSite?: string }) =>
      (await c.getAll(k ? { domain: 'facebook.com', partitionKey: k } : { domain: 'facebook.com' }))
        .map((x) => x.name)
        .sort();
    expect(await names()).toEqual(['plain']);
    expect(await names({})).toEqual(['part', 'plain', 'same']);
    expect(await names({ topLevelSite: 'https://instagram.com' })).toEqual(['part']);
    expect(c.all().find((x) => x.name === 'same')?.partitionKey?.hasCrossSiteAncestor).toBe(false);
    expect(await c.remove({ url: 'https://www.facebook.com/', name: 'part' })).not.toBeNull();
    expect(await names({})).toContain('part');
    await c.remove({
      url: 'https://www.facebook.com/',
      name: 'part',
      partitionKey: { topLevelSite: 'https://instagram.com' },
    });
    expect(await names({})).toEqual(['plain', 'same']);
  });
});

describe('fake tabs and scripting', () => {
  test('query by match pattern and active flag, reload, update, create', async () => {
    const chrome = fakeChrome({
      tabs: [
        { url: 'https://www.facebook.com/home', active: true },
        { url: 'https://m.facebook.com/' },
        { url: 'https://www.instagram.com/' },
        { url: 'chrome://newtab/' },
      ],
    });
    const fb = await chrome.tabs.query({ url: ['*://*.facebook.com/*'] });
    expect(fb.map((t) => t.url)).toEqual([
      'https://www.facebook.com/home',
      'https://m.facebook.com/',
    ]);
    expect(await chrome.tabs.query({ url: '*://*.facebook.com/*', active: true })).toHaveLength(1);
    expect(await chrome.tabs.query({})).toHaveLength(4);
    await chrome.tabs.reload(fb[0]?.id ?? 0);
    expect(chrome.tabs.reloaded).toEqual([fb[0]?.id ?? 0]);
    await expect(chrome.tabs.reload(99)).rejects.toThrow();
    expect(await chrome.tabs.update(3, { url: 'https://www.youtube.com/' })).toMatchObject({
      url: 'https://www.youtube.com/',
    });
    await expect(chrome.tabs.update(99, { url: 'x' })).rejects.toThrow();
    expect(await chrome.tabs.create({ url: 'https://www.youtube.com/' })).toMatchObject({
      id: 5,
      active: true,
    });
  });

  test('match patterns', () => {
    expect(matchesPattern('*://*.facebook.com/*', 'https://facebook.com/')).toBe(true);
    expect(matchesPattern('*://*.facebook.com/*', 'https://notfacebook.com/')).toBe(false);
    expect(matchesPattern('*://*.facebook.com/*', 'ftp://www.facebook.com/')).toBe(false);
    expect(
      matchesPattern('https://www.youtube.com/watch*', 'https://www.youtube.com/watch?v=1'),
    ).toBe(true);
    expect(matchesPattern('https://www.youtube.com/watch*', 'http://www.youtube.com/watch')).toBe(
      false,
    );
    expect(matchesPattern('https://www.youtube.com/*', 'https://m.youtube.com/')).toBe(false);
    expect(matchesPattern('*://*/*', 'https://any.example/')).toBe(true);
    expect(matchesPattern('bad pattern', 'https://x.com/')).toBe(false);
    expect(matchesPattern('*://*/*', 'not a url')).toBe(false);
  });

  test('executeScript returns the result set for the tab, in the MAIN world', async () => {
    const chrome = fakeChrome();
    chrome.scripting.pageResults.set(7, { SESSION_INDEX: 1 });
    const func = (): unknown => 0;
    expect(
      await chrome.scripting.executeScript({ target: { tabId: 7 }, world: 'MAIN', func }),
    ).toEqual([{ result: { SESSION_INDEX: 1 } }]);
    expect(
      await chrome.scripting.executeScript({ target: { tabId: 8 }, world: 'MAIN', func }),
    ).toEqual([{}]);
    expect(chrome.scripting.calls).toEqual([
      { tabId: 7, world: 'MAIN' },
      { tabId: 8, world: 'MAIN' },
    ]);
  });

  test('storage areas keep JSON copies', async () => {
    const { local } = fakeChrome().storage;
    const value = { a: [1, { b: 2 }] };
    await local.set({ k: value, other: 1 });
    value.a.push(3);
    expect(await local.get('k')).toEqual({ k: { a: [1, { b: 2 }] } });
    expect(await local.get(['k', 'missing'])).toEqual({ k: { a: [1, { b: 2 }] } });
    await local.remove(['k', 'other']);
    expect(local.dump()).toEqual({});
  });
});
