import { describe, expect, test } from 'bun:test';
import { COOKIE_PLATFORMS, isCookiePlatform } from '../../src/background/platforms';
import { createMutex } from '../../src/lib/mutex';

describe('platforms (design 3.1 and 3.2)', () => {
  test('Facebook and Instagram settings', () => {
    expect(COOKIE_PLATFORMS.facebook).toMatchObject({
      cookieDomain: 'facebook.com',
      idCookie: 'c_user',
      tabPatterns: ['*://*.facebook.com/*'],
    });
    expect([...COOKIE_PLATFORMS.facebook.deviceCookies]).toEqual([
      'datr',
      'sb',
      'locale',
      'wd',
      'dpr',
    ]);
    expect(COOKIE_PLATFORMS.instagram).toMatchObject({
      cookieDomain: 'instagram.com',
      idCookie: 'ds_user_id',
      tabPatterns: ['*://*.instagram.com/*'],
    });
    expect([...COOKIE_PLATFORMS.instagram.deviceCookies]).toEqual([
      'mid',
      'ig_did',
      'ig_nrcb',
      'datr',
    ]);
    expect(isCookiePlatform('facebook')).toBe(true);
    expect(isCookiePlatform('youtube')).toBe(false);
  });

  test.each([
    ['facebook', 'https://www.facebook.com/checkpoint/1501092823525282/', true],
    ['facebook', 'https://m.facebook.com/checkpoint', true],
    ['facebook', 'https://www.facebook.com/challenge/x', true],
    ['facebook', 'https://www.facebook.com/home.php', false],
    ['facebook', 'https://www.facebook.com/groups/checkpoint/', false],
    ['facebook', 'not a url', false],
    ['instagram', 'https://www.instagram.com/challenge/?next=/', true],
    ['instagram', 'https://www.instagram.com/accounts/suspended/', true],
    ['instagram', 'https://www.instagram.com/p/abc/', false],
    ['instagram', '::', false],
  ] as const)('%s %s → %p', (platform, url, expected) => {
    expect(COOKIE_PLATFORMS[platform].isCheckpointUrl(url)).toBe(expected);
  });
});

describe('mutex', () => {
  test('runs jobs one at a time in order, and a failed job does not block the next', async () => {
    const m = createMutex();
    const order: string[] = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('a');
      return 1;
    });
    const failing = m.run(async () => {
      order.push('b');
      throw new Error('b failed');
    });
    const last = m.run(async () => {
      order.push('c');
      return 3;
    });
    expect(await slow).toBe(1);
    await expect(failing).rejects.toThrow('b failed');
    expect(await last).toBe(3);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
