// The one list of sites (src/lib/sites.ts) and the matcher that tells which platform a tab's URL is on.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { COOKIE_PLATFORMS } from '../../src/background/platforms';
import { hostPattern, platformOfUrl, SITES, type Site } from '../../src/lib/sites';
import { tabPattern } from '../../src/popup/bridge';

const manifest = JSON.parse(
  readFileSync(new URL('../../src/manifest.json', import.meta.url), 'utf8'),
) as { host_permissions: string[] };

describe('platformOfUrl', () => {
  const yes: [string, string][] = [
    ['https://www.facebook.com/', 'facebook'],
    ['https://facebook.com/groups/1', 'facebook'],
    ['https://m.facebook.com/home.php', 'facebook'],
    ['https://web.facebook.com/?sk=h_chr', 'facebook'],
    ['http://www.facebook.com/', 'facebook'],
    ['https://WWW.FaceBook.COM/Profile', 'facebook'],
    ['https://www.facebook.com./', 'facebook'],
    ['https://www.facebook.com:443/x', 'facebook'],
    ['https://www.instagram.com/explore/', 'instagram'],
    ['https://instagram.com/p/abc', 'instagram'],
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://m.youtube.com/', 'youtube'],
    ['https://music.youtube.com/', 'youtube'],
    ['https://user:pass@www.youtube.com/', 'youtube'],
  ];
  for (const [url, platform] of yes)
    test(`${url} → ${platform}`, () => expect(platformOfUrl(url)).toBe(platform as never));

  const no = [
    'https://facebook.com.evil.test/',
    'https://www.facebook.com.evil.test/login',
    'https://notfacebook.com/',
    'https://fakefacebook.com/',
    'https://facebook.co/',
    'https://youtube.com@evil.test/',
    'https://www.youtube.com@evil.test/watch',
    'https://evil.test/?u=https://www.youtube.com/',
    'https://evil.test/#www.instagram.com',
    'https://instagram.com-login.evil.test/',
    'https://xn--facebook-xyz.com/',
    'https://youtu.be/abc',
    'https://accounts.google.com/',
    'ftp://www.facebook.com/',
    'file:///home/me/facebook.com/index.html',
    'chrome://settings/?search=facebook.com',
    'chrome-extension://abc/popup/index.html',
    'about:blank',
    'facebook.com',
    'not a url',
    '',
  ];
  for (const url of no)
    test(`${JSON.stringify(url)} → null`, () => expect(platformOfUrl(url)).toBeNull());

  test('undefined (Chrome hides the URL of a site without host permission) → null', () => {
    expect(platformOfUrl(undefined)).toBeNull();
  });

  test('a new site is one more entry in the list, the matcher is unchanged', () => {
    const more: Site[] = [...SITES, { platform: 'tiktok' as never, domain: 'tiktok.com' }];
    expect(platformOfUrl('https://www.tiktok.com/@someone', more)).toBe('tiktok' as never);
    expect(platformOfUrl('https://www.tiktok.com/@someone')).toBeNull();
    expect(platformOfUrl('https://tiktok.com.evil.test/', more)).toBeNull();
  });
});

describe('the site list drives every host list', () => {
  test('manifest host_permissions are exactly the sites', () => {
    expect([...manifest.host_permissions].sort()).toEqual(SITES.map(hostPattern).sort());
  });

  test('the popup tab counts and the cookie platforms use the same patterns', () => {
    for (const site of SITES) expect(tabPattern(site.platform)).toBe(hostPattern(site));
    for (const p of Object.values(COOKIE_PLATFORMS)) {
      const site = SITES.find((s) => s.platform === p.id);
      expect(site?.domain).toBe(p.cookieDomain);
      expect(p.tabPatterns).toEqual([hostPattern(site as Site)]);
    }
  });
});
