// docs/design.md 8.3 item 11: every popup state renders in happy-dom, in English and Thai.
import { describe, expect, test } from 'bun:test';
import { reduce } from '../../src/popup/controller';
import { createTranslator, type Language } from '../../src/popup/i18n';
import {
  baseState,
  EXTRA_STATES,
  type ExtraName,
  SAMPLE_STATES,
  type SampleName,
  sampleState,
} from '../../src/popup/samples';
import { initialState, type PopupState, screenOf } from '../../src/popup/state';
import { patchHints, patchSwitchStep, renderPopup } from '../../src/popup/view';

const LANGS: Language[] = ['en', 'th'];
const draw = (state: PopupState, lang: Language): HTMLElement => {
  const root = document.createElement('main');
  document.body.replaceChildren(root);
  renderPopup(root, state, createTranslator(lang));
  return root;
};
/** Visible text: names are wrapped in invisible bidi isolates (checked in the bidi test). */
const vis = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/[\u2068\u2069]/g, '');
const q = (root: HTMLElement, id: string): HTMLElement | null =>
  root.querySelector(`[data-testid="${id}"]`);

const EXPECT_SCREEN: Record<SampleName, string> = {
  list: 'list',
  empty: 'empty',
  'add-form': 'adding',
  'add-not-logged-in': 'adding',
  switching: 'switching',
  success: 'success',
  error: 'error',
  rename: 'rename',
  delete: 'delete',
  youtube: 'success',
  locked: 'locked',
  'locked-wrong': 'locked',
  'wipe-confirm': 'locked',
  settings: 'settings',
  'settings-wipe': 'settings',
};

// one landmark per state that proves the right screen was drawn
const LANDMARK: Record<SampleName, string> = {
  list: 'account-list',
  empty: 'empty',
  'add-form': 'add-form',
  'add-not-logged-in': 'add-not-logged-in',
  switching: 'switch-step',
  success: 'toast',
  error: 'error',
  rename: 'rename-input',
  delete: 'confirm-delete',
  youtube: 'toast',
  locked: 'locked',
  'locked-wrong': 'pw-hint',
  'wipe-confirm': 'wipe-confirm',
  settings: 'settings',
  'settings-wipe': 'settings-wipe-confirm',
};

describe('every state renders in en and th', () => {
  for (const lang of LANGS) {
    for (const name of SAMPLE_STATES) {
      test(`${name} (${lang})`, () => {
        const state = sampleState(name, lang, lang === 'th' ? 'Facebook 4' : 'Facebook 4');
        const root = draw(state, lang);
        expect(root.dataset.state).toBe(EXPECT_SCREEN[name]);
        expect(screenOf(state) as string).toBe(EXPECT_SCREEN[name]);
        expect(q(root, LANDMARK[name])).not.toBeNull();
        // nothing is left as an unfilled key, token or marker
        const text = root.textContent ?? '';
        expect(text).not.toMatch(/\$[A-Z]+\$|\[\[|\]\]|undefined|\{[a-z]+\}/);
        expect(root.querySelector('h1')?.textContent).toBeTruthy();
        // every control has a name: text, aria-label or title
        for (const b of root.querySelectorAll('button')) {
          const label =
            (b.textContent ?? '').trim() || b.getAttribute('aria-label') || b.getAttribute('title');
          expect(label).toBeTruthy();
        }
        // the footer is on every screen
        expect(root.querySelector('.foot')).not.toBeNull();
      });
    }
  }
});

describe('screens', () => {
  test('list: active account first, with the Active chip and a disabled switch button', () => {
    const root = draw(baseState('en'), 'en');
    const rows = [...root.querySelectorAll('.row')];
    expect(rows.map((r) => (r as HTMLElement).dataset.id)).toEqual(['fb1', 'fb2', 'fb3']);
    expect(rows[0]?.classList.contains('active')).toBe(true);
    expect(rows[0]?.querySelector('.chip.on')?.textContent).toBe('Active');
    expect(rows[0]?.querySelector<HTMLButtonElement>('.main')?.disabled).toBe(true);
    expect(rows[1]?.querySelector('.sub')?.textContent).toBe('ID ••••0937 · Used 2 h ago');
    expect(rows[2]?.querySelector('.chip.bad')?.textContent).toBe('Log in again');
    expect(root.querySelector('.tab[aria-selected="true"]')?.textContent).toContain('Facebook');
    expect([...root.querySelectorAll('.tab .count')].map((c) => c.textContent)).toEqual([
      '3',
      '0',
      '3',
      '0',
    ]);
  });

  test('list in Thai uses the reviewed wording', () => {
    const root = draw(baseState('th'), 'th');
    expect(root.querySelectorAll('.row')[1]?.querySelector('.sub')?.textContent).toBe(
      'ID ••••0937 · ใช้เมื่อ 2 ชม. ก่อน',
    );
    expect(root.querySelector('.section-label')?.textContent).toContain('บัญชี Facebook (3)');
  });

  test('a row that is not first in the list is re-sorted so the active one leads', () => {
    const state = baseState('en');
    state.platforms.facebook.activeId = 'fb3';
    const root = draw(state, 'en');
    expect((root.querySelector('.row') as HTMLElement).dataset.id).toBe('fb3');
  });

  test('empty: three steps, the note and both buttons, per platform', () => {
    const root = draw(sampleState('empty', 'en'), 'en');
    expect(root.querySelectorAll('.empty ol li').length).toBe(3);
    expect(root.querySelector('.empty h2')?.textContent).toBe('No Instagram accounts yet');
    expect(q(root, 'open-site')?.textContent).toBe('Open instagram.com');
    expect(root.dataset.platform).toBe('instagram');
  });

  test('youtube tab: Google hint, note, and Google account sub-lines', () => {
    const state = baseState('en');
    state.platform = 'youtube';
    const root = draw(state, 'en');
    expect(root.querySelector('.section-label')?.textContent).toContain(
      "Uses Google's account system",
    );
    expect(root.querySelector('.note.info')?.textContent).toContain('multi-account');
    const subs = [...root.querySelectorAll('.row .sub')].map((s) => s.textContent);
    expect(subs).toContain('Brand · Google account 1 · Used yesterday');
    expect(root.dataset.platform).toBe('youtube');
  });

  test('switching: busy row with spinner, step text and bars; the rest is dimmed and disabled', () => {
    const root = draw(sampleState('switching', 'en'), 'en');
    expect(root.querySelector('.row.busy .spinner')?.getAttribute('role')).toBe('progressbar');
    expect(q(root, 'switch-step')?.textContent).toBe('Saving the current session…');
    expect(root.querySelectorAll('.row.busy .steps i.done').length).toBe(1);
    expect(root.querySelector('.list')?.classList.contains('dim')).toBe(true);
    expect(q(root, 'settings-btn')?.hasAttribute('disabled')).toBe(true);
    expect(q(root, 'tab-youtube')?.hasAttribute('disabled')).toBe(true);
    expect(q(root, 'add-account')?.hasAttribute('disabled')).toBe(true);
  });

  test('switching step labels: reload names the tab count (plural), youtube has two steps', () => {
    const state = sampleState('switching', 'en');
    if (state.switching) state.switching.step = 2;
    expect(q(draw(state, 'en'), 'switch-step')?.textContent).toBe('Reloading 2 tabs…');
    state.platforms.facebook.openTabs = 1;
    expect(q(draw(state, 'en'), 'switch-step')?.textContent).toBe('Reloading 1 tab…');
    const yt = baseState('en');
    yt.platform = 'youtube';
    yt.switching = { id: 'yt3', step: 0 };
    const root = draw(yt, 'en');
    expect(q(root, 'switch-step')?.textContent).toBe('Switching the Google account…');
    expect(root.querySelectorAll('.steps i').length).toBe(2);
    yt.switching = { id: 'yt3', step: 9 };
    expect(q(draw(yt, 'en'), 'switch-step')?.textContent).toBe('Reloading 3 tabs…');
  });

  test('success: the new active row, a green flash and the toast with the reloaded tabs', () => {
    const root = draw(sampleState('success', 'en'), 'en');
    expect(q(root, 'flash-fb2')?.classList.contains('ok')).toBe(true);
    expect(vis(q(root, 'toast'))).toContain('Switched to Orange Bakery');
    expect(q(root, 'toast')?.textContent).toContain('Reloaded 2 tabs');
    expect(vis(q(root, 'toast')?.querySelector('b'))).toBe('Orange Bakery');
    expect((root.querySelector('.row') as HTMLElement).dataset.id).toBe('fb2');
  });

  test('success in Thai says "แล้ว" after the reload line', () => {
    const root = draw(sampleState('success', 'th'), 'th');
    expect(q(root, 'toast')?.textContent).toContain('รีโหลด 2 แท็บ แล้ว');
  });

  test('error: alert with the account name, a red flash, the active account unchanged', () => {
    const root = draw(sampleState('error', 'en'), 'en');
    const err = q(root, 'error');
    expect(err?.getAttribute('role')).toBe('alert');
    expect(vis(err)).toContain('The session for “Client work A” has expired');
    expect(err?.querySelector('b')?.textContent).toBe('Update session');
    expect(q(root, 'flash-fb3')?.classList.contains('bad')).toBe(true);
    expect(root.querySelector('.row.active')?.getAttribute('data-id')).toBe('fb1');
  });

  test('rename: input holds the current name, focus lands in it, hint shows the limit', () => {
    const root = draw(sampleState('rename', 'en'), 'en');
    const input = q(root, 'rename-input') as HTMLInputElement;
    expect(input.value).toBe('Orange Bakery');
    expect(input.maxLength).toBe(40);
    expect(q(root, 'rename-hint')?.textContent).toContain('40 characters');
    expect(document.activeElement).toBe(input);
  });

  test('rename with an empty value shows the error hint', () => {
    const state = sampleState('rename', 'en');
    if (state.editing) state.editing = { ...state.editing, value: '', bad: true };
    const root = draw(state, 'en');
    expect(q(root, 'rename-hint')?.classList.contains('bad')).toBe(true);
    expect(q(root, 'rename-hint')?.textContent).toBe('Enter at least 1 character');
  });

  test('delete: confirm replaces the row; the active account also says you stay logged in', () => {
    const root = draw(sampleState('delete', 'en'), 'en');
    const confirm = q(root, 'confirm-delete');
    expect(vis(confirm)).toContain('Remove “Client work A” from the list?');
    expect(confirm?.textContent).toContain('Your Facebook account is not deleted.');
    expect(confirm?.textContent).not.toContain('stay logged in');
    const state = sampleState('delete', 'en');
    state.confirmDelete = 'fb1';
    expect(q(draw(state, 'en'), 'confirm-delete')?.textContent).toContain(
      'You stay logged in in your tabs',
    );
    state.platform = 'youtube';
    state.confirmDelete = 'yt2';
    expect(q(draw(state, 'en'), 'confirm-delete')?.textContent).toContain(
      'Your Google account is untouched.',
    );
  });

  test('add form: found-account line, name input, defaults and the YouTube variant', () => {
    const root = draw(sampleState('add-form', 'en', 'Facebook 4'), 'en');
    expect(root.querySelector('.panel .meta')?.textContent).toContain('Facebook ID ••••3052');
    expect((q(root, 'add-input') as HTMLInputElement).value).toBe('Facebook 4');
    const state = sampleState('add-form', 'en', 'x');
    state.platform = 'youtube';
    if (state.adding?.kind === 'form') state.adding = { ...state.adding, idTail: '2' };
    expect(draw(state, 'en').querySelector('.panel .meta')?.textContent).toContain(
      'Google account 2',
    );
    if (state.adding?.kind === 'form') state.adding = { ...state.adding, bad: true };
    expect(q(draw(state, 'en'), 'add-hint')?.classList.contains('bad')).toBe(true);
  });

  test('add on an empty platform keeps the form instead of the empty screen', () => {
    const state = sampleState('empty', 'en');
    state.adding = { kind: 'notLoggedIn' };
    const root = draw(state, 'en');
    expect(q(root, 'add-not-logged-in')).not.toBeNull();
    expect(q(root, 'empty')).toBeNull();
  });

  test('not logged in: warning with the platform and a button to open the site', () => {
    const root = draw(sampleState('add-not-logged-in', 'en'), 'en');
    expect(q(root, 'add-not-logged-in')?.textContent).toContain('No Facebook login found');
    expect(root.querySelector('.btn.primary')?.textContent).toBe('Open facebook.com');
  });

  test('locked: password field, no gear button, hint and Unlock; the wrong-password variants', () => {
    const root = draw(sampleState('locked', 'en'), 'en');
    expect(q(root, 'settings-btn')).toBeNull();
    expect((q(root, 'pw-input') as HTMLInputElement).type).toBe('password');
    expect(q(root, 'pw-hint')?.textContent).toBe('At least 10 characters.');
    expect(q(root, 'unlock')?.textContent).toBe('Unlock');
    expect(document.activeElement).toBe(q(root, 'pw-input'));
    const wrong = draw(sampleState('locked-wrong', 'en'), 'en');
    expect(q(wrong, 'pw-hint')?.textContent).toBe('Wrong password. Try again.');
    expect(wrong.querySelector('.pw')?.classList.contains('bad')).toBe(true);
  });

  test('locked: shown password, and every unlock button face', () => {
    const state = sampleState('locked', 'en');
    state.lock = { ...state.lock, show: true, password: 'abc' };
    const root = draw(state, 'en');
    expect((q(root, 'pw-input') as HTMLInputElement).type).toBe('text');
    expect((q(root, 'pw-input') as HTMLInputElement).value).toBe('abc');
    expect(q(root, 'pw-toggle')?.getAttribute('aria-label')).toBe('Hide password');
    const faces: Record<string, string> = {
      loading: 'Unlocking…',
      ok: 'Unlocked',
      err: 'Try again',
    };
    for (const [button, text] of Object.entries(faces)) {
      state.lock = { ...state.lock, button: button as 'loading' | 'ok' | 'err' };
      const btn = q(draw(state, 'en'), 'unlock');
      expect(btn?.textContent).toContain(text);
      expect(btn?.dataset.btnState).toBe(button);
    }
    state.lock = { ...state.lock, button: 'loading' };
    expect(q(draw(state, 'en'), 'unlock')?.hasAttribute('disabled')).toBe(true);
    expect(q(draw(state, 'en'), 'unlock')?.querySelector('.spinner')).not.toBeNull();
  });

  test('forgot password: the wipe confirm replaces Unlock', () => {
    const root = draw(sampleState('wipe-confirm', 'en'), 'en');
    expect(q(root, 'wipe-confirm')?.textContent).toContain('Forgot your password?');
    expect(q(root, 'unlock')).toBeNull();
    expect(q(root, 'wipe-ok')?.textContent).toBe('Wipe data');
  });

  test('settings: theme and language segments reflect the choice; titles differ from their buttons', () => {
    const state = sampleState('settings', 'en');
    state.settings = { ...state.settings, theme: 'dark', language: 'th', uiLanguage: 'th' };
    const root = draw(state, 'en');
    expect(q(root, 's-theme-dark')?.getAttribute('aria-pressed')).toBe('true');
    expect(q(root, 's-theme-system')?.getAttribute('aria-pressed')).toBe('false');
    expect(q(root, 's-lang-th')?.getAttribute('aria-pressed')).toBe('true');
    expect(q(root, 's-lang-th')?.getAttribute('lang')).toBe('th');
    expect(root.querySelector('[data-card="lang"] p')?.textContent).toBe(
      'Auto follows the browser language (now: Thai).',
    );
    // carryover 5: no card title equals the button inside it
    for (const card of root.querySelectorAll('.set-card')) {
      const title = card.querySelector('h2')?.textContent;
      const button = card.querySelector('button.btn')?.textContent?.replace('…', '');
      if (button) expect(title).not.toBe(button);
    }
    expect(q(root, 'lock-now')?.textContent).toBe('Lock now');
    expect(q(root, 's-wipe')?.textContent).toBe('Wipe all data…');
    expect(q(root, 'settings-back')?.getAttribute('aria-label')).toBe('Back');
  });

  test('settings wipe confirm swaps the danger card', () => {
    const root = draw(sampleState('settings-wipe', 'en'), 'en');
    expect(q(root, 's-wipe')).toBeNull();
    expect(q(root, 's-wipe-ok')?.textContent).toBe('Wipe everything');
  });

  test('Thai Auto hint names the browser language in Thai', () => {
    const state = sampleState('settings', 'th');
    state.settings = { ...state.settings, uiLanguage: 'en' };
    expect(draw(state, 'th').querySelector('[data-card="lang"] p')?.textContent).toContain('อังกฤษ');
  });
});

describe('safety', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  test('account names are text, never markup, everywhere they appear', () => {
    const state = baseState('en');
    const a = state.platforms.facebook.accounts[1];
    if (!a) throw new Error('seed');
    a.label = evil;
    a.initials = '<';
    for (const name of ['list', 'delete', 'rename', 'error', 'success'] as const) {
      const s = structuredClone(state);
      if (name === 'delete') s.confirmDelete = 'fb2';
      if (name === 'rename') s.editing = { id: 'fb2', value: evil, bad: false };
      if (name === 'error') s.error = { id: 'fb2', code: 'expired' };
      if (name === 'success') s.toast = { name: evil, tabs: 2 };
      const root = draw(s, 'en');
      expect(root.querySelector('img:not(.mark)')).toBeNull();
      expect(root.querySelectorAll('img:not(.mark), script, svg[onload]').length).toBe(0);
    }
    const root = draw(state, 'en');
    expect(root.querySelector('.row[data-id="fb2"] .nm')?.textContent).toBe(evil);
    expect(
      (root.querySelector('.row[data-id="fb2"] .main')?.getAttribute('aria-label') ?? '').replace(
        /[\u2068\u2069]/g,
        '',
      ),
    ).toBe(`Switch to ${evil}`);
  });

  test('add form and rename values cannot break out of the value attribute', () => {
    const s = sampleState('add-form', 'en', evil);
    const root = draw(s, 'en');
    expect((q(root, 'add-input') as HTMLInputElement).value).toBe(evil);
    expect(root.querySelector('img:not(.mark)')).toBeNull();
  });

  test('a bad id in an effect-free state still renders', () => {
    const s = initialState();
    expect(draw(s, 'en').dataset.state).toBe('empty');
    s.error = { id: 'gone', code: 'expired' };
    expect(vis(q(draw(s, 'en'), 'error'))).toContain('The session for “” has expired');
  });
});

describe('patches', () => {
  test('patchSwitchStep moves the text and bars in place without replacing the row', () => {
    const state = sampleState('switching', 'en');
    const root = draw(state, 'en');
    const row = root.querySelector('.row.busy');
    if (state.switching) state.switching = { ...state.switching, step: 1 };
    patchSwitchStep(root, state, createTranslator('en'));
    expect(root.querySelector('.row.busy')).toBe(row);
    expect(q(root, 'switch-step')?.textContent).toBe('Applying the new session…');
    expect(root.querySelectorAll('.steps i.done').length).toBe(2);
  });

  test('patchSwitchStep does nothing when no switch is running or the row is gone', () => {
    const state = baseState('en');
    const root = draw(state, 'en');
    const before = root.innerHTML;
    patchSwitchStep(root, state, createTranslator('en'));
    expect(root.innerHTML).toBe(before);
    state.switching = { id: 'fb2', step: 1 };
    patchSwitchStep(root, state, createTranslator('en'));
    expect(root.innerHTML).toBe(before);
  });

  test('patchHints clears the error hint on the rename, add and password fields', () => {
    const tr = createTranslator('en');
    const rename = sampleState('rename', 'en');
    if (rename.editing) rename.editing = { ...rename.editing, value: '', bad: true };
    let root = draw(rename, 'en');
    if (rename.editing) rename.editing = { ...rename.editing, value: 'x', bad: false };
    patchHints(root, rename, tr);
    expect(q(root, 'rename-hint')?.classList.contains('bad')).toBe(false);
    expect(q(root, 'rename-hint')?.textContent).toContain('40 characters');

    const add = sampleState('add-form', 'en', 'n');
    if (add.adding?.kind === 'form') add.adding = { ...add.adding, bad: true };
    root = draw(add, 'en');
    if (add.adding?.kind === 'form') add.adding = { ...add.adding, bad: false };
    patchHints(root, add, tr);
    expect(q(root, 'add-hint')?.classList.contains('bad')).toBe(false);

    const lock = sampleState('locked-wrong', 'en');
    root = draw(lock, 'en');
    lock.lock = { ...lock.lock, bad: false };
    patchHints(root, lock, tr);
    expect(q(root, 'pw-hint')?.textContent).toBe('At least 10 characters.');
    expect(root.querySelector('.pw')?.classList.contains('bad')).toBe(false);
  });

  test('patchHints is harmless on screens without those fields', () => {
    const state = baseState('en');
    const root = draw(state, 'en');
    const before = root.innerHTML;
    patchHints(root, state, createTranslator('en'));
    expect(root.innerHTML).toBe(before);
    state.editing = { id: 'fb1', value: '', bad: true };
    patchHints(root, state, createTranslator('en'));
    expect(root.innerHTML).toBe(before);
  });
});

describe('layout facts that tests rely on', () => {
  test('the toast comes before the footer in the DOM, so it never covers the footer or a button', () => {
    const root = draw(sampleState('success', 'en'), 'en');
    const kids = [...root.children].map((c) => c.className || c.tagName.toLowerCase());
    expect(kids.indexOf('toast')).toBeGreaterThan(kids.indexOf('body'));
    expect(kids.indexOf('toast')).toBeLessThan(kids.indexOf('foot'));
  });

  test('the password placeholder is short; the rule lives in the hint under the field', () => {
    const root = draw(sampleState('locked', 'en'), 'en');
    expect((q(root, 'pw-input') as HTMLInputElement).placeholder).toBe('Master password');
    expect(q(root, 'pw-hint')?.textContent).toBe('At least 10 characters.');
  });

  test('name fields are direction-neutral (dir=auto)', () => {
    expect(q(draw(sampleState('rename', 'en'), 'en'), 'rename-input')?.getAttribute('dir')).toBe(
      'auto',
    );
    expect(
      q(draw(sampleState('add-form', 'en', 'x'), 'en'), 'add-input')?.getAttribute('dir'),
    ).toBe('auto');
  });

  test('a name with a right-to-left override is isolated everywhere it is spoken or shown', () => {
    const state = baseState('en');
    const a = state.platforms.facebook.accounts[1];
    if (a) a.label = '‮evil';
    state.confirmDelete = 'fb2';
    const root = draw(state, 'en');
    expect(root.querySelector('.nm')?.textContent).toBeDefined();
    expect(q(root, 'confirm-delete')?.textContent).toContain('⁨‮evil⁩');
    expect(q(root, 'rename-fb2')).toBeNull(); // the row is replaced by the confirm
    const list = draw({ ...state, confirmDelete: null }, 'en');
    expect(list.querySelector('[data-testid=rename-fb2]')?.getAttribute('aria-label')).toContain(
      '⁨‮evil⁩',
    );
  });
});

describe('extra states used by the contrast gate render in en and th', () => {
  const LANDMARK_EXTRA: Record<ExtraName, string> = {
    'tt-list': 'account-list',
    'tt-empty': 'empty',
    'tt-error': 'notice',
    'delete-active': 'confirm-delete',
    'add-bad': 'add-hint',
    'rename-bad': 'rename-hint',
    'ig-form': 'add-form',
    'ig-not-logged-in': 'add-not-logged-in',
    'yt-list': 'account-list',
    'yt-error': 'error',
    'yt-rename': 'rename-input',
    'yt-delete': 'confirm-delete',
    loading: 'loading',
    setup: 'setup',
    'setup-short': 'setup-create',
    'setup-creating': 'setup-create',
    'locked-blocked': 'unlock',
    checkpoint: 'error',
    'wrong-account': 'error',
    notice: 'notice',
    'notice-unsaved': 'notice',
    'platform-busy': 'account-list',
    'lock-loading': 'unlock',
    'lock-ok': 'unlock',
    'lock-err': 'unlock',
  };
  for (const lang of LANGS) {
    for (const name of EXTRA_STATES) {
      test(`${name} (${lang})`, () => {
        const root = draw(sampleState(name, lang, 'x'), lang);
        expect(q(root, LANDMARK_EXTRA[name])).not.toBeNull();
        expect(root.textContent).not.toMatch(/\$[A-Z]+\$|undefined/);
      });
    }
  }

  test('the variants show what their names say', () => {
    expect(q(draw(sampleState('add-bad', 'en'), 'en'), 'add-hint')?.classList.contains('bad')).toBe(
      true,
    );
    expect(
      q(draw(sampleState('rename-bad', 'en'), 'en'), 'rename-hint')?.classList.contains('bad'),
    ).toBe(true);
    expect(draw(sampleState('ig-form', 'en'), 'en').dataset.platform).toBe('instagram');
    expect(draw(sampleState('yt-error', 'en'), 'en').dataset.platform).toBe('youtube');
    expect(
      q(draw(sampleState('yt-error', 'en'), 'en'), 'flash-yt3')?.classList.contains('bad'),
    ).toBe(true);
    expect(q(draw(sampleState('lock-loading', 'en'), 'en'), 'unlock')?.dataset.btnState).toBe(
      'loading',
    );
    expect(q(draw(sampleState('lock-ok', 'en'), 'en'), 'unlock')?.dataset.btnState).toBe('ok');
    expect(q(draw(sampleState('lock-err', 'en'), 'en'), 'unlock')?.dataset.btnState).toBe('err');
    expect(
      q(draw(sampleState('delete-active', 'en'), 'en'), 'confirm-delete')?.textContent,
    ).toContain('stay logged in');
  });
});

describe('official logos', () => {
  test('every platform mark is a hidden image from inside the extension, next to the text name', () => {
    for (const platform of ['facebook', 'instagram', 'youtube'] as const) {
      const s = baseState('en');
      s.platform = platform;
      const root = draw(s, 'en');
      const marks = [...root.querySelectorAll<HTMLImageElement>('img.mark')];
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks) {
        expect(m.getAttribute('src')).toMatch(
          /^\/brands\/(facebook|instagram|youtube|tiktok)\.svg$/,
        );
        expect(m.getAttribute('alt')).toBe('');
        expect(m.getAttribute('aria-hidden')).toBe('true');
      }
      expect(root.querySelector(`[data-tab="${platform}"] img.mark`)?.getAttribute('src')).toBe(
        `/brands/${platform}.svg`,
      );
      expect(root.querySelector(`[data-tab="${platform}"]`)?.textContent).toContain(
        platform === 'youtube' ? 'YouTube' : platform === 'facebook' ? 'Facebook' : 'Instagram',
      );
    }
  });
});

describe('YouTube add form shows only real data', () => {
  const youtubeForm = (found: { idTail: string; defaultName: string; brand?: boolean }) => {
    let s = baseState('en');
    s = reduce(s, { type: 'tab', platform: 'youtube' }).state;
    s = reduce(s, { type: 'add-probed', found }).state;
    return draw(s, 'en');
  };
  test('the Google account number the worker read, with Brand when there is a channel', () => {
    expect(
      q(youtubeForm({ idTail: '2', defaultName: 'x' }), 'add-form')?.querySelector('.meta')
        ?.textContent,
    ).toBe('Google account 2');
    expect(
      q(youtubeForm({ idTail: '3', defaultName: 'x', brand: true }), 'add-form')?.querySelector(
        '.meta',
      )?.textContent,
    ).toBe('Brand · Google account 3');
  });
  test('nothing read, no line (and never the old fixed text)', () => {
    const root = youtubeForm({ idTail: '', defaultName: 'x' });
    expect(q(root, 'add-form')?.querySelector('.meta')).toBeNull();
    expect(root.textContent).not.toContain('personal channel');
  });
});

describe('drawing again under a field the person is typing in', () => {
  test.each([
    ['rename', 'rename', 'rename-input'],
    ['add', 'add', 'add-input'],
  ] as const)('%s field keeps its value, caret and focus', (_n, kind, id) => {
    const s = sampleState('list', 'en');
    const fb = s.platforms.facebook.accounts[0]?.id ?? '';
    const opened =
      kind === 'rename'
        ? reduce(s, { type: 'rename', id: fb }).state
        : sampleState('add-form', 'en', 'Shop');
    const root = draw(opened, 'en');
    const input = root.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`no #${id}`);
    input.focus();
    input.setSelectionRange(2, 4);
    renderPopup(root, { ...opened, stale: false, toast: null }, createTranslator('en'));
    const again = root.querySelector<HTMLInputElement>(`#${id}`);
    expect(again?.value).toBe(input.value);
    expect(document.activeElement).toBe(again);
    expect([again?.selectionStart, again?.selectionEnd]).toEqual([2, 4]);
  });
});
