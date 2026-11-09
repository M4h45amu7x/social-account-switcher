// Instagram (docs/design.md 3.2).
import { CHECKPOINT_PATH } from './facebook';
import type { CookiePlatform } from './types';

export const instagram: CookiePlatform = {
  id: 'instagram',
  label: 'Instagram',
  cookieDomain: 'instagram.com',
  tabPatterns: ['*://*.instagram.com/*'],
  idCookie: 'ds_user_id',
  deviceCookies: new Set(['mid', 'ig_did', 'ig_nrcb', 'datr']),
  loginUrl: 'https://www.instagram.com/accounts/login/',
  // Instagram's identity checks live under /challenge/; /accounts/suspended/ is its block page.
  isCheckpointUrl: (url) => {
    try {
      const path = new URL(url).pathname;
      return CHECKPOINT_PATH.test(path) || path.startsWith('/accounts/suspended');
    } catch {
      return false;
    }
  },
};
