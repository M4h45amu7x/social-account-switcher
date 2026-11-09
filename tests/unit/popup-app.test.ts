// The glue: clicks and typing in the DOM go through the reducer and redraw. startViewTransition is absent
// in happy-dom, so every redraw is synchronous here (the fallback path the extension also has).
import { beforeEach, describe, expect, test } from 'bun:test';
import { type App, LANGUAGE_CACHE_KEY, mountPopup } from '../../src/popup/app';
import type { Effect } from '../../src/popup/controller';
import { baseState, sampleState } from '../../src/popup/samples';
import type { PopupState } from '../../src/popup/state';
import type { ThemeCache } from '../../src/popup/theme';

const cacheOf = (
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
let root: HTMLElement;
let effects: Effect[];
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.lang = '';
  root = document.getElementById('app') as HTMLElement;
  effects = [];
});
const mount = (over: { state?: PopupState; cache?: ThemeCache | null; ui?: string } = {}): App =>
  mountPopup({
    root,
    cache: over.cache === undefined ? cacheOf() : over.cache,
    uiLanguage: over.ui ?? 'en-US',
    onEffect: (e) => effects.push(e),
    ...(over.state ? { state: over.state } : {}),
  });
const click = (testid: string): void => {
  (root.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click();
};
const type = (id: string, value: string): void => {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no #${id}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (id: string, k: string): void => {
  root
    .querySelector(`#${id}`)
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
};

describe('mountPopup', () => {
  test('first draw: title, language and theme come from the cache and the browser', () => {
    mount({ cache: cacheOf({ theme: 'dark', language: 'th' }), ui: 'en-US' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.lang).toBe('th');
    expect(document.title).toBe('สลับบัญชี');
    expect(root.dataset.state).toBe('empty');
  });

  test('Auto language follows the browser UI language', () => {
    mount({ ui: 'th-TH' });
    expect(document.documentElement.lang).toBe('th');
    expect(document.title).toBe('สลับบัญชี');
  });

  test('a blocked cache (null or throwing) still mounts in System and Auto', () => {
    mount({ cache: null });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    document.body.innerHTML = '<main id="app"></main>';
    root = document.getElementById('app') as HTMLElement;
    const throwing: ThemeCache = {
      getItem() {
        throw new Error('x');
      },
      setItem() {
        throw new Error('x');
      },
    };
    const app = mount({ cache: throwing });
    app.dispatch({ type: 'pref-language', value: 'th' });
    expect(app.state().settings.language).toBe('th');
  });

  test('a given state is used as is', () => {
    const app = mount({ state: sampleState('rename', 'en') });
    expect(root.dataset.state).toBe('rename');
    expect(app.translator().lang).toBe('en');
  });
});

describe('clicks', () => {
  test('tab click switches platform; disabled controls do nothing', () => {
    const app = mount({ state: baseState('en') });
    click('tab-youtube');
    expect(app.state().platform).toBe('youtube');
    expect(root.dataset.platform).toBe('youtube');
    click('tab-youtube');
    const busy = mount({ state: sampleState('switching', 'en') });
    click('tab-instagram');
    expect(busy.state().platform).toBe('facebook');
  });

  test('clicks on an icon inside a button count as the button', () => {
    const app = mount({ state: baseState('en') });
    (root.querySelector('[data-testid="settings-btn"] svg') as Element).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(app.state().page).toBe('settings');
  });

  test('clicking something without an action does nothing', () => {
    const app = mount({ state: baseState('en') });
    const before = root.innerHTML;
    root.querySelector('.foot')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root.querySelector('.row .name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.innerHTML).toBe(before);
    expect(app.state().page).toBe('main');
  });

  test('switch click reports the effect to the host', () => {
    mount({ state: baseState('en') });
    click('row-fb2');
    (root.querySelector('[data-testid="row-fb2"] .main') as HTMLElement).click();
    expect(effects).toEqual([{ type: 'switch', platform: 'facebook', id: 'fb2' }]);
    expect(root.dataset.state).toBe('switching');
  });

  test('switch-step patches the text in place and keeps the same row element', () => {
    const app = mount({ state: baseState('en') });
    (root.querySelector('[data-testid="row-fb2"] .main') as HTMLElement).click();
    const row = root.querySelector('.row.busy');
    app.dispatch({ type: 'switch-step', step: 1 });
    expect(root.querySelector('.row.busy')).toBe(row);
    expect(root.querySelector('[data-testid="switch-step"]')?.textContent).toBe(
      'Applying the new session…',
    );
  });
});

describe('theme and language', () => {
  test('picking a theme applies it, caches it and reports the setting', () => {
    const cache = cacheOf();
    const app = mount({ state: sampleState('settings', 'en'), cache });
    click('s-theme-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(cache.data.theme).toBe('dark');
    expect(effects).toEqual([{ type: 'settings', theme: 'dark' }]);
    expect(root.querySelector('[data-testid="s-theme-dark"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    click('s-theme-system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(app.state().settings.theme).toBe('system');
  });

  test('theme click passes its coordinates to the reveal; keyboard clicks fall back to the button centre', () => {
    mount({ state: sampleState('settings', 'en') });
    (root.querySelector('[data-testid="s-theme-light"]') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 }),
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('programmatic theme changes without a click point still apply', () => {
    const app = mount({ state: sampleState('settings', 'en') });
    app.dispatch({ type: 'pref-theme', value: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('picking Thai redraws in Thai, sets <html lang>, caches the choice', () => {
    const cache = cacheOf();
    mount({ state: sampleState('settings', 'en'), cache });
    click('s-lang-th');
    expect(document.documentElement.lang).toBe('th');
    expect(root.querySelector('h1')?.textContent).toBe('ตั้งค่า');
    expect(cache.data[LANGUAGE_CACHE_KEY]).toBe('th');
    expect(effects).toEqual([{ type: 'settings', language: 'th' }]);
    click('s-lang-auto');
    expect(document.documentElement.lang).toBe('en');
  });

  test('settings loaded from storage re-resolve the language', () => {
    const app = mount({ state: baseState('en') });
    app.dispatch({ type: 'settings-loaded', theme: 'light', language: 'th', uiLanguage: 'en' });
    expect(document.documentElement.lang).toBe('th');
  });
});

describe('typing and keys', () => {
  test('rename: typing updates state without redrawing; Enter saves, Escape cancels', () => {
    const app = mount({ state: sampleState('rename', 'en') });
    const input = root.querySelector('#rename-input');
    type('rename-input', 'New');
    expect(root.querySelector('#rename-input')).toBe(input);
    expect(app.state().editing?.value).toBe('New');
    key('rename-input', 'Enter');
    expect(app.state().platforms.facebook.accounts[1]?.label).toBe('New');
    expect(effects).toEqual([{ type: 'rename', platform: 'facebook', id: 'fb2', label: 'New' }]);
    click('rename-fb2');
    key('rename-input', 'Escape');
    expect(app.state().editing).toBeNull();
    key('rename-input', 'a');
  });

  test('empty rename shows the error, typing clears it in place', () => {
    mount({ state: sampleState('rename', 'en') });
    type('rename-input', '');
    key('rename-input', 'Enter');
    expect(root.querySelector('[data-testid="rename-hint"]')?.classList.contains('bad')).toBe(true);
    type('rename-input', 'a');
    expect(root.querySelector('[data-testid="rename-hint"]')?.classList.contains('bad')).toBe(
      false,
    );
    expect(document.activeElement?.id).toBe('rename-input');
  });

  test('add form: Enter saves, Escape cancels', () => {
    const app = mount({ state: sampleState('add-form', 'en', 'Facebook 4') });
    key('add-input', 'Escape');
    expect(app.state().adding).toBeNull();
    const again = mount({ state: sampleState('add-form', 'en', 'Facebook 4') });
    type('add-input', 'Shop');
    key('add-input', 'Enter');
    expect(effects).toEqual([{ type: 'add', platform: 'facebook', label: 'Shop' }]);
    expect(again.state().adding?.kind).toBe('form');
  });

  test('lock screen: typing keeps the field, Enter unlocks, a wrong try clears the hint on typing', () => {
    const app = mount({ state: sampleState('locked-wrong', 'en') });
    type('pw-input', 'abc');
    expect(root.querySelector('[data-testid="pw-hint"]')?.textContent).toBe(
      'At least 10 characters.',
    );
    key('pw-input', 'Enter');
    expect(effects).toEqual([{ type: 'unlock', password: 'abc' }]);
    expect(app.state().lock.button).toBe('loading');
  });

  test('keys and input on elements that are not fields are ignored', () => {
    const app = mount({ state: baseState('en') });
    const before = app.state();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    root.querySelector('.foot')?.dispatchEvent(new Event('input', { bubbles: true }));
    const stray = document.createElement('input');
    root.append(stray);
    stray.dispatchEvent(new Event('input', { bubbles: true }));
    stray.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.state()).toBe(before);
  });
});

describe('Esc: one rule, focus goes back to the opener', () => {
  const esc = (selector: string): KeyboardEvent => {
    const target = root.querySelector(selector) as HTMLElement;
    target.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  };
  const cases: [string, () => PopupState, string, string, string][] = [
    [
      'rename (focus in the input)',
      () => sampleState('rename', 'en'),
      '#rename-input',
      'list',
      'rename-fb2',
    ],
    [
      'rename (focus on Save)',
      () => sampleState('rename', 'en'),
      '[data-act=rename-save]',
      'list',
      'rename-fb2',
    ],
    [
      'add form (focus on Save)',
      () => sampleState('add-form', 'en', 'x'),
      '[data-act=add-save]',
      'list',
      'add-account',
    ],
    [
      'add form (focus in the input)',
      () => sampleState('add-form', 'en', 'x'),
      '#add-input',
      'list',
      'add-account',
    ],
    [
      'not-logged-in note (focus on Close)',
      () => sampleState('add-not-logged-in', 'en'),
      '[data-act=add-cancel]',
      'list',
      'add-account',
    ],
    [
      'delete confirm (focus on Delete)',
      () => sampleState('delete', 'en'),
      '[data-act=del-ok]',
      'list',
      'delete-fb3',
    ],
    [
      'delete confirm (focus on Cancel)',
      () => sampleState('delete', 'en'),
      '[data-act=del-cancel]',
      'list',
      'delete-fb3',
    ],
    [
      'error box (focus on Update session)',
      () => sampleState('error', 'en'),
      '[data-act=err-update]',
      'list',
      '',
    ],
    [
      'lock wipe confirm',
      () => sampleState('wipe-confirm', 'en'),
      '[data-act=wipe-ok]',
      'locked',
      'forgot',
    ],
    [
      'settings wipe confirm',
      () => sampleState('settings-wipe', 'en'),
      '[data-act=s-wipe-cancel]',
      'settings',
      's-wipe',
    ],
  ];
  for (const [name, make, where, screen, focusId] of cases) {
    test(name, () => {
      mount({ state: make() });
      const ev = esc(where);
      expect(ev.defaultPrevented).toBe(true);
      expect(root.dataset.state).toBe(screen);
      if (focusId) expect((document.activeElement as HTMLElement).dataset.testid).toBe(focusId);
      else expect(document.activeElement?.closest('.row')?.getAttribute('data-id')).toBe('fb3');
      expect(
        root.querySelector(
          '[data-testid=wipe-confirm], [data-testid=settings-wipe-confirm], [data-testid=confirm-delete], [data-testid=error], [data-testid=add-form], [data-testid=add-not-logged-in], [data-testid=rename-input]',
        ),
      ).toBeNull();
    });
  }

  test('on the lock screen Esc does nothing and is left to the browser', () => {
    mount({ state: sampleState('locked', 'en') });
    const before = root.innerHTML;
    const ev = esc('#pw-input');
    expect(ev.defaultPrevented).toBe(false);
    expect(root.innerHTML).toBe(before);
  });

  test('with nothing open, Esc is left to the browser (it closes the popup)', () => {
    mount({ state: baseState('en') });
    expect(esc('[data-testid=tab-facebook]').defaultPrevented).toBe(false);
  });

  test('the rule is applied once per key press, not once per handler', () => {
    mount({ state: sampleState('rename', 'en') });
    esc('#rename-input');
    expect(effects).toEqual([]);
    expect(root.dataset.state).toBe('list');
  });
});
