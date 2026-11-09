// Test stand-ins for the Facebook and Instagram definitions that card B3 adds under
// src/background/platforms/. The values follow docs/design.md 3.1 and 3.2.
import type { CookiePlatform } from '../../src/background/platforms/types';

const checkpoint = (url: string) => /\/(checkpoint|challenge)\//.test(new URL(url).pathname);

export const facebook: CookiePlatform = {
  id: 'facebook',
  label: 'Facebook',
  cookieDomain: 'facebook.com',
  tabPatterns: ['*://*.facebook.com/*'],
  idCookie: 'c_user',
  deviceCookies: new Set(['datr', 'sb', 'locale', 'wd', 'dpr']),
  loginUrl: 'https://www.facebook.com/login/',
  isCheckpointUrl: checkpoint,
};

export const instagram: CookiePlatform = {
  id: 'instagram',
  label: 'Instagram',
  cookieDomain: 'instagram.com',
  tabPatterns: ['*://*.instagram.com/*'],
  idCookie: 'ds_user_id',
  deviceCookies: new Set(['mid', 'ig_did', 'ig_nrcb', 'datr']),
  loginUrl: 'https://www.instagram.com/accounts/login/',
  isCheckpointUrl: checkpoint,
};
