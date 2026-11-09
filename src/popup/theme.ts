// Theme: System / Light / Dark. "System" is no data-theme attribute at all, so the stylesheet's
// prefers-color-scheme rule decides (and follows the OS live). The choice is mirrored into
// localStorage under the key `theme`, because public/theme-boot.js has to read it synchronously
// before first paint (docs/design.md section 11).

export type ThemePref = 'system' | 'light' | 'dark';

export const THEME_CACHE_KEY = 'theme';
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** The two Storage methods this module needs; tests pass a fake, and a blocked storage may throw. */
export interface ThemeCache {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseThemePref(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readThemeCache(cache: ThemeCache | null): ThemePref {
  try {
    return parseThemePref(cache?.getItem(THEME_CACHE_KEY));
  } catch {
    return 'system';
  }
}

export function writeThemeCache(cache: ThemeCache | null, pref: ThemePref): void {
  try {
    cache?.setItem(THEME_CACHE_KEY, pref);
  } catch {
    // The cache is only a speed-up for the next first paint.
  }
}

export function applyTheme(root: HTMLElement, pref: ThemePref): void {
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/**
 * The stored setting wins over the cache: apply it, and fix the cache when it was behind (for example
 * after the setting changed from another popup window).
 */
export function reconcileTheme(
  root: HTMLElement,
  cache: ThemeCache | null,
  stored: ThemePref,
): ThemePref {
  applyTheme(root, stored);
  if (readThemeCache(cache) !== stored) writeThemeCache(cache, stored);
  return stored;
}
