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
      d({ name: '__Host-a', url: 'https://www.facebook.com/x/', path: '/x' }),
      d({ url: 'https://www.notfacebook.com/' }), // no host permission
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
    expect(await c.set(d({ expirationDate: 1 }))).toBeUndefined(); // an expired cookie deletes it
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

describe('fake cookies match Chromium where QC t-535 found differences', () => {
  const twin = (flag: boolean) =>
    d({
      name: 'twin',
      value: `x-${flag}`,
      sameSite: 'no_restriction',
      partitionKey: { topLevelSite: 'https://instagram.com', hasCrossSiteAncestor: flag },
    });

  test('two cookies that differ only in hasCrossSiteAncestor are kept apart', async () => {
    const c = fakeCookies();
    await c.set(twin(false));
    await c.set(twin(true));
    expect(
      c
        .all()
        .map((x) => x.value)
        .sort(),
    ).toEqual(['x-false', 'x-true']);
  });

  test('remove() with the wrong flag deletes nothing; with the right one, only that cookie', async () => {
    const c = fakeCookies();
    await c.set(twin(true));
    await c.remove({
      url: 'https://www.facebook.com/',
      name: 'twin',
      partitionKey: { topLevelSite: 'https://instagram.com', hasCrossSiteAncestor: false },
    });
    expect(c.all()).toHaveLength(1);
    await c.set(twin(false));
    await c.remove({
      url: 'https://www.facebook.com/',
      name: 'twin',
      partitionKey: { topLevelSite: 'https://instagram.com', hasCrossSiteAncestor: true },
    });
    expect(c.all().map((x) => x.value)).toEqual(['x-false']);
    // Without a flag Chromium works it out from the URL: facebook.com is cross-site to instagram.com.
    await c.set(twin(true));
    await c.remove({
      url: 'https://www.facebook.com/',
      name: 'twin',
      partitionKey: { topLevelSite: 'https://instagram.com' },
    });
    expect(c.all().map((x) => x.value)).toEqual(['x-false']);
  });

  test('a path the URL does not reach, or an expired date, resolves with undefined', async () => {
    const c = fakeCookies({ now: 10_000 });
    expect(await c.set(d({ url: 'https://www.facebook.com/a', path: '/b' }))).toBeUndefined();
    expect(await c.set(d({ expirationDate: 1 }))).toBeUndefined();
    expect(c.all()).toEqual([]);
  });

  test('no host permission: set and remove throw, getAll hides the cookie', async () => {
    const all = fakeCookies(undefined, ['*://*/*']);
    await all.set(d({ url: 'https://www.notfacebook.com/', name: 'x' }));
    const limited = fakeCookies(undefined, ['*://*.facebook.com/*']);
    await expect(limited.set(d({ url: 'https://www.notfacebook.com/' }))).rejects.toThrow(
      'no host permission',
    );
    await expect(
      limited.remove({ url: 'https://www.notfacebook.com/', name: 'x' }),
    ).rejects.toThrow('no host permission');
    expect(await all.getAll({ domain: 'notfacebook.com' })).toHaveLength(1);
    expect(await limited.getAll({})).toEqual([]);
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
    expect(await chrome.tabs.query({ url: ['*://*.facebook.com/*'], active: true })).toHaveLength(
      1,
    );
    expect(await chrome.tabs.query({})).toHaveLength(4);
    await chrome.tabs.reload(fb[0]?.id ?? 0);
    expect(chrome.tabs.reloaded).toEqual([fb[0]?.id ?? 0]);
    await expect(chrome.tabs.reload(99)).rejects.toThrow();
    // Like Chrome: update() resolves before commit, still on the old URL, heading to pendingUrl.
    expect(
      await chrome.tabs.update(3, { url: 'https://www.youtube.com/', active: true }),
    ).toMatchObject({
      url: 'https://www.instagram.com/',
      pendingUrl: 'https://www.youtube.com/',
      active: true,
      status: 'loading',
    });
    expect(chrome.tabs.tabs.filter((t) => t.active).map((t) => t.id)).toEqual([3]);
    await expect(chrome.tabs.update(99, { url: 'x', active: false })).rejects.toThrow();
    expect(
      await chrome.tabs.create({ url: 'https://www.youtube.com/', active: true }),
    ).toMatchObject({
      id: 5,
      active: true,
    });
  });

  test('onUpdated follows Chrome: url only on a changed commit, hidden outside host permissions', async () => {
    const chrome = fakeChrome({ tabs: [{ url: 'https://www.youtube.com/watch?v=1' }] });
    const seen: string[] = [];
    chrome.tabs.onUpdated.addListener((id, info, tab) => {
      seen.push(`${id} ${JSON.stringify(info)} ${tab.url ?? '(hidden)'}`);
    });
    // until the fake has sent the events of the loads so far (a fixed sleep missed them on a busy host)
    const loaded = async (events: number) => {
      for (let i = 0; i < 400 && seen.length < events; i += 1)
        await new Promise((r) => setTimeout(r, 5));
    };

    // A 302 back to the same URL: the URL did not change, so no url.
    chrome.tabs.redirect = () => 'https://www.youtube.com/watch?v=1';
    await chrome.tabs.update(1, { url: 'https://www.youtube.com/signin?x', active: true });
    await loaded(2);
    // To Google's login page: no permission for google.com, so hidden.
    chrome.tabs.redirect = () => 'https://accounts.google.com/signin';
    await chrome.tabs.update(1, { url: 'https://www.youtube.com/signin?x', active: true });
    await loaded(4);
    expect((await chrome.tabs.get(1)).url).toBeUndefined();
    expect(await chrome.tabs.query({ url: ['*://*.youtube.com/*'] })).toEqual([]);
    // A visible change does carry the url; a new tab starts with an empty URL.
    chrome.tabs.redirect = null;
    const created = await chrome.tabs.create({
      url: 'https://www.youtube.com/feed',
      active: false,
    });
    expect(created).toMatchObject({ url: '', pendingUrl: 'https://www.youtube.com/feed' });
    await loaded(6);
    expect(seen).toEqual([
      '1 {"status":"loading"} https://www.youtube.com/watch?v=1',
      '1 {"status":"complete"} https://www.youtube.com/watch?v=1',
      '1 {"status":"loading"} (hidden)',
      '1 {"status":"complete"} (hidden)',
      '2 {"status":"loading","url":"https://www.youtube.com/feed"} https://www.youtube.com/feed',
      '2 {"status":"complete"} https://www.youtube.com/feed',
    ]);
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
    ).toEqual([{ frameId: 0, result: { SESSION_INDEX: 1 } }]);
    expect(
      await chrome.scripting.executeScript({ target: { tabId: 8 }, world: 'MAIN', func }),
    ).toEqual([{ frameId: 0 }]);
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
