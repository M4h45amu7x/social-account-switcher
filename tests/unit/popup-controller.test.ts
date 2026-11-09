import { describe, expect, test } from 'bun:test';
import {
  type Effect,
  escapeTarget,
  type PopupAction,
  parseAction,
  reduce,
} from '../../src/popup/controller';
import { baseState, sampleState } from '../../src/popup/samples';
import type { PopupState } from '../../src/popup/state';

const run = (s: PopupState, ...actions: PopupAction[]) => {
  let step = reduce(s, { type: 'input', field: 'password', value: '' });
  let state = s;
  const effects: Effect[] = [];
  for (const a of actions) {
    step = reduce(state, a);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, step, effects };
};
const el = (data: Record<string, string>): HTMLElement => {
  const b = document.createElement('button');
  Object.assign(b.dataset, data);
  return b;
};

describe('parseAction', () => {
  test('reads tabs, prefs and acts from data attributes', () => {
    expect(parseAction(el({ tab: 'youtube' }))).toEqual({ type: 'tab', platform: 'youtube' });
    expect(parseAction(el({ tab: 'myspace' }))).toBeNull();
    expect(parseAction(el({ pref: 'theme', value: 'dark' }))).toEqual({
      type: 'pref-theme',
      value: 'dark',
    });
    expect(parseAction(el({ pref: 'theme', value: 'neon' }))).toBeNull();
    expect(parseAction(el({ pref: 'language', value: 'th' }))).toEqual({
      type: 'pref-language',
      value: 'th',
    });
    expect(parseAction(el({ pref: 'language', value: 'fr' }))).toBeNull();
    expect(parseAction(el({ act: 'switch', id: 'fb2' }))).toEqual({ type: 'switch', id: 'fb2' });
    expect(parseAction(el({ act: 'del-ok', id: 'fb2' }))).toEqual({ type: 'del-ok', id: 'fb2' });
    expect(parseAction(el({ act: 'switch' }))).toBeNull();
    expect(parseAction(el({ act: 'del-ok' }))).toBeNull();
    expect(parseAction(el({ act: 'add-save' }))).toEqual({ type: 'add-save' });
    expect(parseAction(el({ act: 's-wipe-ok' }))).toEqual({ type: 's-wipe-ok' });
    expect(parseAction(el({ act: 'launch-missiles' }))).toBeNull();
    expect(parseAction(el({}))).toBeNull();
  });

  test('every act the view emits is understood', () => {
    const acts = [
      'settings-open',
      'settings-close',
      'rename-cancel',
      'rename-save',
      'del-cancel',
      'add',
      'add-cancel',
      'add-save',
      'err-close',
      'err-update',
      'open-site',
      'unlock',
      'pw-toggle',
      'forgot',
      'wipe-cancel',
      'wipe-ok',
      'lock-now',
      's-wipe',
      's-wipe-cancel',
      's-wipe-ok',
    ];
    for (const act of acts) expect(parseAction(el({ act }))?.type as string).toBe(act);
  });
});

describe('navigation', () => {
  test('switching tab picks the slide direction and drops transient screens', () => {
    const s = sampleState('delete', 'en');
    const fwd = reduce(s, { type: 'tab', platform: 'youtube' });
    expect(fwd.mode).toBe('tab');
    expect(fwd.dir).toBe(1);
    expect(fwd.state.platform).toBe('youtube');
    expect(fwd.state.confirmDelete).toBeNull();
    const back = reduce(fwd.state, { type: 'tab', platform: 'facebook' });
    expect(back.dir).toBe(-1);
  });

  test('picking the current tab does nothing', () => {
    const r = reduce(baseState('en'), { type: 'tab', platform: 'facebook' });
    expect(r.render).toBe(false);
  });

  test('settings open and close slide the page', () => {
    const open = reduce(baseState('en'), { type: 'settings-open' });
    expect(open.state.page).toBe('settings');
    expect(open).toMatchObject({ mode: 'page', dir: 1 });
    const s = reduce(open.state, { type: 's-wipe' }).state;
    const close = reduce(s, { type: 'settings-close' });
    expect(close.state.page).toBe('main');
    expect(close.state.settings.wipeConfirm).toBe(false);
    expect(close.dir).toBe(-1);
  });

  test('preferences produce a settings effect once and ignore a repeat', () => {
    const theme = reduce(baseState('en'), { type: 'pref-theme', value: 'dark' });
    expect(theme.mode).toBe('theme');
    expect(theme.effects).toEqual([{ type: 'settings', theme: 'dark' }]);
    expect(reduce(theme.state, { type: 'pref-theme', value: 'dark' }).render).toBe(false);
    const lang = reduce(baseState('en'), { type: 'pref-language', value: 'th' });
    expect(lang.mode).toBe('lang');
    expect(lang.effects).toEqual([{ type: 'settings', language: 'th' }]);
    expect(reduce(lang.state, { type: 'pref-language', value: 'th' }).render).toBe(false);
  });
});

describe('switching', () => {
  test('start, steps, success: active moves, used lines update, toast has the tab count', () => {
    const { state, effects } = run(
      baseState('en'),
      { type: 'switch', id: 'fb2' },
      { type: 'switch-step', step: 1 },
      { type: 'switch-done', ok: true },
    );
    expect(effects).toEqual([{ type: 'switch', platform: 'facebook', id: 'fb2' }]);
    const fb = state.platforms.facebook;
    expect(fb.activeId).toBe('fb2');
    expect(fb.accounts.find((a) => a.id === 'fb1')?.used).toEqual({ kind: 'justNow' });
    expect(fb.accounts.find((a) => a.id === 'fb2')?.used).toEqual({ kind: 'now' });
    expect(state.toast).toEqual({ name: 'Orange Bakery', tabs: 2 });
    expect(state.flash).toEqual({ id: 'fb2', kind: 'ok' });
    expect(state.switching).toBeNull();
  });

  test('failure keeps the old active account and opens the error note', () => {
    const { state } = run(
      baseState('en'),
      { type: 'switch', id: 'fb3' },
      { type: 'switch-done', ok: false },
    );
    expect(state.platforms.facebook.activeId).toBe('fb1');
    expect(state.error).toEqual({ id: 'fb3' });
    expect(state.flash?.kind).toBe('bad');
    expect(state.toast).toBeNull();
  });

  test('a second switch while one runs, an unknown id, and stray results are ignored', () => {
    const busy = sampleState('switching', 'en');
    expect(reduce(busy, { type: 'switch', id: 'fb3' }).render).toBe(false);
    expect(reduce(baseState('en'), { type: 'switch', id: 'zz' }).render).toBe(false);
    expect(reduce(baseState('en'), { type: 'switch-done', ok: true }).render).toBe(false);
    const idle = reduce(baseState('en'), { type: 'switch-step', step: 2 });
    expect(idle.render).toBe(false);
    expect(idle.state.switching).toBeNull();
  });

  test('switch-step updates the step without asking for a redraw', () => {
    const r = reduce(sampleState('switching', 'en'), { type: 'switch-step', step: 2 });
    expect(r.render).toBe(false);
    expect(r.state.switching?.step).toBe(2);
  });

  test('flash and toast clear only when set', () => {
    const done = sampleState('success', 'en');
    expect(reduce(done, { type: 'flash-clear' })).toMatchObject({ mode: 'status', render: true });
    expect(reduce(done, { type: 'toast-clear' })).toMatchObject({ mode: 'toast', render: true });
    expect(reduce(baseState('en'), { type: 'flash-clear' }).render).toBe(false);
    expect(reduce(baseState('en'), { type: 'toast-clear' }).render).toBe(false);
  });
});

describe('rename', () => {
  test('open, type, save: trims, clips to 40, updates initials, sends the effect', () => {
    const { state, effects } = run(
      baseState('en'),
      { type: 'rename', id: 'fb2' },
      { type: 'input', field: 'rename', value: `  ${'x'.repeat(50)}  ` },
      { type: 'rename-save' },
    );
    const a = state.platforms.facebook.accounts.find((x) => x.id === 'fb2');
    expect(a?.label).toBe('x'.repeat(40));
    expect(a?.initials).toBe('X');
    expect(state.editing).toBeNull();
    expect(effects).toEqual([
      { type: 'rename', platform: 'facebook', id: 'fb2', label: 'x'.repeat(40) },
    ]);
  });

  test('an empty name flags the field and typing clears the flag', () => {
    const empty = run(
      baseState('en'),
      { type: 'rename', id: 'fb2' },
      { type: 'input', field: 'rename', value: '  ' },
      { type: 'rename-save' },
    );
    expect(empty.state.editing?.bad).toBe(true);
    expect(empty.step.render).toBe(true);
    expect(empty.effects).toEqual([]);
    const typed = reduce(empty.state, { type: 'input', field: 'rename', value: 'a' });
    expect(typed.state.editing?.bad).toBe(false);
    expect(typed.render).toBe(false);
  });

  test('cancel, unknown id, save with no editor', () => {
    const open = reduce(baseState('en'), { type: 'rename', id: 'fb2' }).state;
    expect(reduce(open, { type: 'rename-cancel' }).state.editing).toBeNull();
    expect(reduce(baseState('en'), { type: 'rename', id: 'zz' }).render).toBe(false);
    expect(reduce(baseState('en'), { type: 'rename-save' }).render).toBe(false);
    expect(reduce(baseState('en'), { type: 'input', field: 'rename', value: 'x' }).render).toBe(
      false,
    );
  });
});

describe('delete', () => {
  test('confirm then delete removes the account; deleting the active one clears active', () => {
    const { state, effects, step } = run(
      baseState('en'),
      { type: 'delete', id: 'fb1' },
      { type: 'del-ok', id: 'fb1' },
    );
    expect(state.platforms.facebook.accounts.map((a) => a.id)).toEqual(['fb2', 'fb3']);
    expect(state.platforms.facebook.activeId).toBeNull();
    expect(step.mode).toBe('list');
    expect(effects).toEqual([{ type: 'delete', platform: 'facebook', id: 'fb1' }]);
    const other = run(baseState('en'), { type: 'del-ok', id: 'fb3' });
    expect(other.state.platforms.facebook.activeId).toBe('fb1');
  });

  test('cancel and unknown id', () => {
    const open = reduce(baseState('en'), { type: 'delete', id: 'fb3' }).state;
    expect(reduce(open, { type: 'del-cancel' }).state.confirmDelete).toBeNull();
    expect(reduce(baseState('en'), { type: 'delete', id: 'zz' }).render).toBe(false);
  });
});

describe('add', () => {
  test('add asks the worker to probe; the answer opens the form or the warning', () => {
    const asked = reduce(baseState('en'), { type: 'add' });
    expect(asked.effects).toEqual([{ type: 'probe-add', platform: 'facebook' }]);
    expect(asked.render).toBe(false);
    const found = reduce(asked.state, {
      type: 'add-probed',
      found: { idTail: '1234', defaultName: 'Facebook 4' },
    });
    expect(found.state.adding).toEqual({
      kind: 'form',
      value: 'Facebook 4',
      bad: false,
      idTail: '1234',
    });
    expect(found.mode).toBe('expand');
    expect(reduce(asked.state, { type: 'add-probed', found: null }).state.adding).toEqual({
      kind: 'notLoggedIn',
    });
  });

  test('save sends the clipped label; empty flags the field; typing clears it', () => {
    const form = sampleState('add-form', 'en', 'Facebook 4');
    const ok = reduce(form, { type: 'input', field: 'add', value: ' Shop ' });
    expect(ok.render).toBe(false);
    const saved = reduce(ok.state, { type: 'add-save' });
    expect(saved.effects).toEqual([{ type: 'add', platform: 'facebook', label: 'Shop' }]);
    const empty = reduce(reduce(form, { type: 'input', field: 'add', value: '' }).state, {
      type: 'add-save',
    });
    expect(empty.state.adding).toMatchObject({ kind: 'form', bad: true });
    expect(
      reduce(empty.state, { type: 'input', field: 'add', value: 'a' }).state.adding,
    ).toMatchObject({ bad: false });
    expect(reduce(baseState('en'), { type: 'add-save' }).render).toBe(false);
    expect(reduce(baseState('en'), { type: 'input', field: 'add', value: 'x' }).render).toBe(false);
  });

  test('cancel closes it', () => {
    expect(
      reduce(sampleState('add-form', 'en', 'x'), { type: 'add-cancel' }).state.adding,
    ).toBeNull();
  });
});

describe('error note', () => {
  test('update session marks the account fine and asks the worker; close just hides', () => {
    const err = sampleState('error', 'en');
    const upd = reduce(err, { type: 'err-update' });
    const a = upd.state.platforms.facebook.accounts.find((x) => x.id === 'fb3');
    expect(a).toMatchObject({ expired: false, used: { kind: 'updated' } });
    expect(upd.state.error).toBeNull();
    expect(upd.effects).toEqual([{ type: 'update-session', platform: 'facebook', id: 'fb3' }]);
    expect(reduce(err, { type: 'err-close' }).state.error).toBeNull();
    expect(reduce(baseState('en'), { type: 'err-update' }).render).toBe(false);
  });

  test('open-site asks for the login page only while the error shows', () => {
    expect(reduce(sampleState('error', 'en'), { type: 'open-site' }).effects).toEqual([
      { type: 'open-site', platform: 'facebook', login: true },
    ]);
    expect(reduce(baseState('en'), { type: 'open-site' }).effects).toEqual([
      { type: 'open-site', platform: 'facebook', login: false },
    ]);
  });
});

describe('lock', () => {
  test('lock now goes to the lock screen and tells the worker', () => {
    const r = reduce(sampleState('settings', 'en'), { type: 'lock-now' });
    expect(r.state.page).toBe('locked');
    expect(r.effects).toEqual([{ type: 'lock' }]);
    expect(r.dir).toBe(1);
  });

  test('typing, unlock, wrong answer, reset', () => {
    const typed = reduce(sampleState('locked-wrong', 'en'), {
      type: 'input',
      field: 'password',
      value: 'abc',
    });
    expect(typed.state.lock).toMatchObject({ password: 'abc', bad: false });
    expect(typed.render).toBe(false);
    const go = reduce(typed.state, { type: 'unlock' });
    expect(go.state.lock.button).toBe('loading');
    expect(go.effects).toEqual([{ type: 'unlock', password: 'abc' }]);
    expect(reduce(go.state, { type: 'unlock' }).render).toBe(false);
    const wrong = reduce(go.state, { type: 'unlock-result', ok: false });
    expect(wrong.state.lock).toMatchObject({ button: 'err', bad: true, password: '' });
    expect(reduce(wrong.state, { type: 'unlock-reset' }).state.lock.button).toBe('idle');
  });

  test('right answer shows the check, then leaves the lock screen', () => {
    const ok = reduce(reduce(sampleState('locked', 'en'), { type: 'unlock' }).state, {
      type: 'unlock-result',
      ok: true,
    });
    expect(ok.state.lock.button).toBe('ok');
    const done = reduce(ok.state, { type: 'unlock-done' });
    expect(done.state.page).toBe('main');
    expect(done.state.lock).toMatchObject({ button: 'idle', password: '' });
    expect(done.dir).toBe(-1);
  });

  test('show/hide, forgot, cancel', () => {
    const s = sampleState('locked', 'en');
    expect(reduce(s, { type: 'pw-toggle' }).state.lock.show).toBe(true);
    const forgot = reduce(s, { type: 'forgot' });
    expect(forgot.state.lock.wipeConfirm).toBe(true);
    expect(reduce(forgot.state, { type: 'wipe-cancel' }).state.lock.wipeConfirm).toBe(false);
  });

  test('the worker can lock or unlock the popup', () => {
    expect(reduce(baseState('en'), { type: 'locked', locked: true }).state.page).toBe('locked');
    expect(reduce(sampleState('locked', 'en'), { type: 'locked', locked: false }).state.page).toBe(
      'main',
    );
  });

  test('forgot-password wipe clears Facebook and Instagram only; YouTube shortcuts stay', () => {
    const r = reduce(sampleState('wipe-confirm', 'en'), { type: 'wipe-ok' });
    expect(r.state.platforms.facebook.accounts).toEqual([]);
    expect(r.state.platforms.facebook.activeId).toBeNull();
    expect(r.state.platforms.youtube.accounts.length).toBe(3);
    expect(r.state.page).toBe('main');
    expect(r.effects).toEqual([{ type: 'wipe', scope: 'sessions' }]);
    expect(r.state.platforms.facebook.openTabs).toBe(2);
  });
});

describe('settings wipe', () => {
  test('wipe everything clears every platform and goes home', () => {
    let s = sampleState('settings', 'en');
    s = reduce(s, { type: 's-wipe' }).state;
    expect(s.settings.wipeConfirm).toBe(true);
    expect(reduce(s, { type: 's-wipe-cancel' }).state.settings.wipeConfirm).toBe(false);
    const r = reduce(s, { type: 's-wipe-ok' });
    for (const p of ['facebook', 'instagram', 'youtube'] as const)
      expect(r.state.platforms[p].accounts).toEqual([]);
    expect(r.state.page).toBe('main');
    expect(r.state.platform).toBe('facebook');
    expect(r.effects).toEqual([{ type: 'wipe', scope: 'all' }]);
  });
});

describe('results from the worker', () => {
  test('settings-loaded fills the theme, language and browser language', () => {
    const r = reduce(baseState('en'), {
      type: 'settings-loaded',
      theme: 'dark',
      language: 'th',
      uiLanguage: 'th',
    });
    expect(r.state.settings).toMatchObject({ theme: 'dark', language: 'th', uiLanguage: 'th' });
  });

  test('platform-loaded replaces the list; animates only when the count changed', () => {
    const base = baseState('en');
    const same = reduce(base, {
      type: 'platform-loaded',
      platform: 'facebook',
      view: { ...base.platforms.facebook },
    });
    expect(same.mode).toBe('none');
    const fewer = reduce(base, {
      type: 'platform-loaded',
      platform: 'facebook',
      view: { ...base.platforms.facebook, accounts: [] },
    });
    expect(fewer.mode).toBe('list');
    expect(fewer.state.platforms.facebook.accounts).toEqual([]);
  });
});

describe('escapeTarget: one Esc rule', () => {
  const t = (s: PopupState) => escapeTarget(s);
  test('closes the innermost temporary thing and names the opener to focus', () => {
    expect(t(sampleState('rename', 'en'))).toEqual({
      action: { type: 'rename-cancel' },
      focus: '[data-testid="rename-fb2"]',
    });
    expect(t(sampleState('add-form', 'en', 'x'))).toEqual({
      action: { type: 'add-cancel' },
      focus: '[data-testid="add-account"]',
    });
    expect(t(sampleState('add-not-logged-in', 'en'))?.action).toEqual({ type: 'add-cancel' });
    expect(t(sampleState('delete', 'en'))).toEqual({
      action: { type: 'del-cancel' },
      focus: '[data-testid="delete-fb3"]',
    });
    expect(t(sampleState('error', 'en'))).toEqual({
      action: { type: 'err-close' },
      focus: '.row[data-id="fb3"] .main',
    });
    expect(t(sampleState('wipe-confirm', 'en'))).toEqual({
      action: { type: 'wipe-cancel' },
      focus: '[data-testid="forgot"]',
    });
    expect(t(sampleState('settings-wipe', 'en'))).toEqual({
      action: { type: 's-wipe-cancel' },
      focus: '[data-testid="s-wipe"]',
    });
  });

  test('nothing to close: list, empty, settings, lock screen, a running switch', () => {
    expect(t(baseState('en'))).toBeNull();
    expect(t(sampleState('empty', 'en'))).toBeNull();
    expect(t(sampleState('settings', 'en'))).toBeNull();
    expect(t(sampleState('locked', 'en'))).toBeNull();
    expect(t(sampleState('locked-wrong', 'en'))).toBeNull();
    expect(t(sampleState('switching', 'en'))).toBeNull();
  });
});
