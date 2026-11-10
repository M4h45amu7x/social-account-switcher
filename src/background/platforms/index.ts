import { facebook } from './facebook';
import { instagram } from './instagram';
import { tiktok } from './tiktok';
import type { CookiePlatform, CookiePlatformId } from './types';

export const COOKIE_PLATFORMS: Readonly<Record<CookiePlatformId, CookiePlatform>> = {
  facebook,
  instagram,
  tiktok,
};

export const isCookiePlatform = (p: string): p is CookiePlatformId => p in COOKIE_PLATFORMS;
