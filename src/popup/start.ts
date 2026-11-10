// Which platform tab the popup opens on: the site of the browser tab the user is looking at, else the
// tab they picked last time, else the first one. Only the picked tab is remembered (in the same
// localStorage cache as the theme); the page's URL is used once, in memory, and never kept.
import { platformOfUrl } from '../lib/sites';
import type { Platform } from './state';
import type { ThemeCache } from './theme';
import { PLATFORM_ORDER } from './view';

export const PLATFORM_CACHE_KEY = 'platform';

const isPlatform = (v: unknown): v is Platform =>
  typeof v === 'string' && (PLATFORM_ORDER as readonly string[]).includes(v);

export function readPlatformCache(cache: ThemeCache | null): Platform | null {
  try {
    const v = cache?.getItem(PLATFORM_CACHE_KEY);
    return isPlatform(v) ? v : null;
  } catch {
    return null;
  }
}

export function writePlatformCache(cache: ThemeCache | null, platform: Platform): void {
  try {
    cache?.setItem(PLATFORM_CACHE_KEY, platform);
  } catch {
    // only a cache
  }
}

/** Site of the active tab > last picked > first tab. */
export function pickStartPlatform(here: Platform | null, last: Platform | null): Platform {
  return here ?? last ?? (PLATFORM_ORDER[0] as Platform);
}

/**
 * The platform of the active tab's URL, or null when there is none, it is not one of our sites (Chrome
 * hides the URL of a site the extension has no host permission for), or the answer takes longer than
 * `ms`: the popup never waits long for it.
 */
export async function siteOfActiveTab(
  activeTabUrl: () => Promise<string | undefined>,
  ms: number,
  later: (fn: () => void, ms: number) => void,
): Promise<Platform | null> {
  const asked = activeTabUrl().then(
    (url) => platformOfUrl(url),
    () => null,
  );
  const gaveUp = new Promise<null>((resolve) => later(() => resolve(null), ms));
  return Promise.race([asked, gaveUp]);
}
