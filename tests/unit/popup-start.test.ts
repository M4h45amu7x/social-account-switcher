// Which tab the popup opens on (src/popup/start.ts) and what it shows when the browser tab under it is
// already on that site: the site under the popup > the tab picked last time > the first tab.
import { beforeEach, describe, expect, test } from 'bun:test';
import { mountPopup } from '../../src/popup/app';
import { reduce } from '../../src/popup/controller';
import { createTranslator } from '../../src/popup/i18n';
import { baseState, sampleState } from '../../src/popup/samples';
import {
  PLATFORM_CACHE_KEY,
  pickStartPlatform,
  readPlatformCache,
  siteOfActiveTab,
  writePlatformCache,
} from '../../src/popup/start';
import { initialState, type Platform, type PopupState } from '../../src/popup/state';
import type { ThemeCache } from '../../src/popup/theme';
import { renderPopup } from '../../src/popup/view';

const cacheOf = (initial: Record<string, string> = {}) => {
  const data: Record<string, string> = { ...initial };
  const cache: ThemeCache = {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
  return { cache, data };
};
const broken: ThemeCache = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('pickStartPlatform', () => {
  test('the site under the popup wins over the last pick', () => {
    expect(pickStartPlatform('youtube', 'instagram')).toBe('youtube');
  });
  test('no site: the last pick', () => {
    expect(pickStartPlatform(null, 'instagram')).toBe('instagram');
  });
  test('neither: the first tab', () => {
    expect(pickStartPlatform(null, null)).toBe('facebook');
  });
});

describe('the remembered tab', () => {
  test('read back what was written', () => {
    const { cache, data } = cacheOf();
    writePlatformCache(cache, 'youtube');
    expect(data[PLATFORM_CACHE_KEY]).toBe('youtube');
    expect(readPlatformCache(cache)).toBe('youtube');
  });
  test('anything that is not a platform is ignored', () => {
    for (const v of ['tiktok', '', 'Facebook', '__proto__', 'facebook ']) {
      expect(readPlatformCache(cacheOf({ [PLATFORM_CACHE_KEY]: v }).cache)).toBeNull();
    }
  });
  test('blocked or missing storage never throws', () => {
    expect(readPlatformCache(broken)).toBeNull();
    expect(readPlatformCache(null)).toBeNull();
    expect(() => writePlatformCache(broken, 'facebook')).not.toThrow();
    expect(() => writePlatformCache(null, 'facebook')).not.toThrow();
  });
});

describe('siteOfActiveTab', () => {
  const now = (fn: () => void) => fn();
  const never = () => {};
  test('a site URL gives its platform', async () => {
    expect(await siteOfActiveTab(async () => 'https://m.youtube.com/feed', 150, never)).toBe(
      'youtube',
    );
  });
  test('a hidden URL (no host permission), a look-alike or a failure gives null', async () => {
    expect(await siteOfActiveTab(async () => undefined, 150, never)).toBeNull();
    expect(
      await siteOfActiveTab(async () => 'https://facebook.com.evil.test/', 150, never),
    ).toBeNull();
    expect(
      await siteOfActiveTab(() => Promise.reject(new Error('no tabs')), 150, never),
    ).toBeNull();
  });
  test('an answer slower than the wait gives null, and the wait is the one asked for', async () => {
    const asked: number[] = [];
    const slow = () => new Promise<string>(() => {});
    expect(
      await siteOfActiveTab(slow, 150, (fn, ms) => {
        asked.push(ms);
        now(fn);
      }),
    ).toBeNull();
    expect(asked).toEqual([150]);
  });
});

describe('opening the popup on the right tab', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"></main>';
    root = document.getElementById('app') as HTMLElement;
  });
  const mount = (over: { platform?: Platform; here?: Platform | null; cache?: ThemeCache }) =>
    mountPopup({
      root,
      cache: over.cache ?? cacheOf().cache,
      uiLanguage: 'en-US',
      ...(over.platform ? { platform: over.platform } : {}),
      ...(over.here !== undefined ? { here: over.here } : {}),
    });

  test('the first draw is already on that tab, with no slide', () => {
    mount({ platform: 'youtube', here: 'youtube' });
    expect(root.dataset.platform).toBe('youtube');
    expect(root.querySelector('[data-testid="tab-youtube"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  test('a tab the person clicks is remembered; the tab picked for them is not', () => {
    const { cache, data } = cacheOf();
    mount({ platform: 'youtube', here: 'youtube', cache });
    expect(data[PLATFORM_CACHE_KEY]).toBeUndefined();
    (root.querySelector('[data-testid="tab-instagram"]') as HTMLElement).click();
    expect(data[PLATFORM_CACHE_KEY]).toBe('instagram');
  });
});

describe('already on the site', () => {
  const tr = createTranslator('en');
  const draw = (s: PopupState) => {
    const root = document.createElement('main');
    renderPopup(root, s, tr);
    return root;
  };
  const q = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`);
  const here = (
    s: PopupState,
    platform: Platform,
    accountId: string | null = null,
  ): PopupState => ({
    ...s,
    here: { platform, accountId },
  });

  test('empty list: no "Open facebook.com", the main button adds the account on this tab', () => {
    const empty = { ...initialState(), platform: 'facebook' as const };
    const away = draw(empty);
    expect(q(away, 'open-site')).not.toBeNull();
    const there = draw(here(empty, 'facebook'));
    expect(q(there, 'open-site')).toBeNull();
    expect(q(there, 'add-account')?.textContent).toBe('Add the account on this tab');
    expect(q(there, 'empty')?.textContent).toContain('In this tab, log in');
    // on another platform's site, the Facebook tab still sends you to facebook.com
    expect(q(draw(here(empty, 'youtube')), 'open-site')).not.toBeNull();
  });

  test('list: the add button says "on this tab" only on that site', () => {
    const s = baseState('en');
    expect(q(draw(s), 'add-account')?.textContent).toContain("Add the account I'm logged in to");
    expect(q(draw(here(s, 'facebook')), 'add-account')?.textContent).toContain(
      'Add the account on this tab',
    );
    expect(q(draw(here(s, 'instagram')), 'add-account')?.textContent).toContain(
      "Add the account I'm logged in to",
    );
  });

  test('no login found: no button that opens the site again', () => {
    const s = sampleState('add-not-logged-in', 'en');
    expect(draw(s).querySelector('[data-act="open-site"]')).not.toBeNull();
    const there = draw(here(s, s.platform));
    expect(there.querySelector('[data-act="open-site"]')).toBeNull();
    expect(q(there, 'add-not-logged-in')?.textContent).toContain('found in this tab');
  });

  test('the account the tab is logged in to says so, in place of Active', () => {
    const s = baseState('en');
    const [first, second] = s.platforms.facebook.accounts;
    if (!first || !second) throw new Error('samples');
    const active = s.platforms.facebook.activeId;
    const other = active === first.id ? second.id : first.id;
    const root = draw(here(s, 'facebook', other));
    expect(q(root, `row-${other}`)?.querySelector('[data-testid="chip-here"]')?.textContent).toBe(
      'On this tab',
    );
    const chips = (r: HTMLElement, id: string | null) =>
      [...(q(r, `row-${id}`)?.querySelectorAll('.chip') ?? [])].map((c) => c.textContent);
    expect(chips(root, active)).toEqual(['Active']);
    expect(root.querySelectorAll('[data-testid="chip-here"]')).toHaveLength(1);
    // same row: one badge, the truer one
    const same = draw(here(s, 'facebook', active));
    expect(chips(same, active)).toEqual(['On this tab']);
  });

  test('here-account: only for the site under the popup, and only when it changes', () => {
    const s = here(baseState('en'), 'facebook');
    const id = s.platforms.facebook.accounts[0]?.id ?? '';
    const step = reduce(s, { type: 'here-account', platform: 'facebook', accountId: id });
    expect(step.state.here).toEqual({ platform: 'facebook', accountId: id });
    expect(step.render).toBe(true);
    expect(
      reduce(step.state, { type: 'here-account', platform: 'facebook', accountId: id }).render,
    ).toBe(false);
    const elsewhere = reduce(s, { type: 'here-account', platform: 'youtube', accountId: id });
    expect(elsewhere.state.here).toEqual(s.here);
    const nowhere = reduce(baseState('en'), {
      type: 'here-account',
      platform: 'facebook',
      accountId: id,
    });
    expect(nowhere.state.here).toBeNull();
  });
});
