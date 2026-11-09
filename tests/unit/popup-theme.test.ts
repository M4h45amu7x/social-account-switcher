import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyTheme,
  parseThemePref,
  readThemeCache,
  reconcileTheme,
  THEME_CACHE_KEY,
  type ThemeCache,
  writeThemeCache,
} from '../../src/popup/theme';

const fakeCache = (
  initial: Record<string, string> = {},
): ThemeCache & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
};
const blocked: ThemeCache = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('theme', () => {
  test('parseThemePref accepts light and dark; anything else is System', () => {
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
    expect(parseThemePref('system')).toBe('system');
    expect(parseThemePref('purple')).toBe('system');
    expect(parseThemePref(undefined)).toBe('system');
  });

  test('System is no attribute at all; Light and Dark set it', () => {
    const root = document.documentElement;
    applyTheme(root, 'dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyTheme(root, 'light');
    expect(root.getAttribute('data-theme')).toBe('light');
    applyTheme(root, 'system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  test('the cache lives under the key "theme"', () => {
    const cache = fakeCache();
    writeThemeCache(cache, 'dark');
    expect(cache.data).toEqual({ [THEME_CACHE_KEY]: 'dark' });
    expect(THEME_CACHE_KEY).toBe('theme');
    expect(readThemeCache(cache)).toBe('dark');
  });

  test('a blocked or missing storage is survivable', () => {
    expect(readThemeCache(blocked)).toBe('system');
    expect(readThemeCache(null)).toBe('system');
    expect(() => writeThemeCache(blocked, 'dark')).not.toThrow();
    expect(() => writeThemeCache(null, 'dark')).not.toThrow();
  });

  test('the stored setting wins and repairs a stale cache', () => {
    const cache = fakeCache({ theme: 'light' });
    const result = reconcileTheme(document.documentElement, cache, 'dark');
    expect(result).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(cache.data.theme).toBe('dark');
  });

  test('reconcile leaves a correct cache alone', () => {
    const cache = fakeCache({ theme: 'dark' });
    let writes = 0;
    const counting: ThemeCache = {
      getItem: cache.getItem,
      setItem: (k, v) => {
        writes++;
        cache.setItem(k, v);
      },
    };
    reconcileTheme(document.documentElement, counting, 'dark');
    expect(writes).toBe(0);
  });
});

describe('public/theme-boot.js', () => {
  const source = readFileSync(new URL('../../public/theme-boot.js', import.meta.url), 'utf8');
  const run = (storage: unknown): void => {
    new Function('localStorage', source)(storage);
  };

  test('sets data-theme from the cached value before the page paints', () => {
    run(fakeCache({ theme: 'dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('ignores system, unknown values and blocked storage', () => {
    run(fakeCache({ theme: 'system' }));
    run(fakeCache({ theme: 'neon' }));
    run(blocked);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  test('is a classic script (no import/export) so MV3 can run it without a module', () => {
    expect(source).not.toMatch(/^\s*(import|export)\b/m);
  });
});
