import { expect, test } from 'bun:test';
import { platformOfUrl } from '../../src/lib/sites';
import { ERROR_TEXT } from '../../src/popup/errors';
import { initialState } from '../../src/popup/state';
import { PLATFORM_ORDER } from '../../src/popup/view';

test('TikTok is a popup platform with its own state', () => {
  expect(PLATFORM_ORDER).toEqual(['facebook', 'instagram', 'youtube', 'tiktok']);
  expect(initialState().platforms).toHaveProperty('tiktok');
});
test('TikTok opens only on its permitted HTTPS host', () => {
  expect(platformOfUrl('https://www.tiktok.com/@fixture')).toBe('tiktok');
  for (const url of [
    'http://www.tiktok.com/',
    'https://tiktok.com.evil.test/',
    'https://tiktok.com@evil.test/',
    'https://nottiktok.com/',
  ])
    expect(platformOfUrl(url)).toBeNull();
});
test('TikTok failures explain recovery instead of unknown or expired', () => {
  expect(ERROR_TEXT.no_tiktok_tab).toBe('err_no_tiktok_tab');
  expect(ERROR_TEXT.tiktok_probe_unavailable).toBe('err_tiktok_probe_unavailable');
  expect(ERROR_TEXT.rollback_failed).toBe('err_rollback_failed');
});
