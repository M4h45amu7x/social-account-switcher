// Facebook (docs/design.md 3.1).
import type { CookiePlatform } from './types';

export const CHECKPOINT_PATH = /^\/(checkpoint|challenge)(\/|$)/;

export const facebook: CookiePlatform = {
  id: 'facebook',
  label: 'Facebook',
  cookieDomain: 'facebook.com',
  tabPatterns: ['*://*.facebook.com/*'],
  idCookie: 'c_user',
  deviceCookies: new Set(['datr', 'sb', 'locale', 'wd', 'dpr']),
  loginUrl: 'https://www.facebook.com/login/',
  isCheckpointUrl: (url) => {
    try {
      return CHECKPOINT_PATH.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },
};
