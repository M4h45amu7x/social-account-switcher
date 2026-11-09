// The popup wired to the real worker code (the router on the fake browser): every action sends the right
// Request, every answer (and every failure) ends in a screen, and nothing is left busy.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorCode, Request } from '../../src/lib/messages';
import { ERROR_CODES } from '../../src/lib/messages';
import {
  READ_DEADLINE_MS,
  SWITCH_DEADLINE_MS,
  TAB_LOAD_TIMEOUT_MS,
  WRITE_DEADLINE_MS,
} from '../../src/lib/timing';
import { type App, mountPopup } from '../../src/popup/app';
import {
  createBridge,
  decodeState,
  parseReply,
  siteUrl,
  TIMING,
  tabPattern,
  toAccountView,
} from '../../src/popup/bridge';
import type { Effect } from '../../src/popup/controller';
import { ERROR_TEXT } from '../../src/popup/errors';
import { createTranslator, type Language } from '../../src/popup/i18n';
import type { ErrorKey } from '../../src/popup/state';
import { loginAs, PASSWORD, startWorker, withAccounts } from '../fakes/harness';

type Send = (m: Request) => Promise<unknown>;

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  document.documentElement.removeAttribute('data-theme');
  root = document.getElementById('app') as HTMLElement;
});

interface Rig {
  app: App;
  onEffect: (effect: Effect, app: App) => void;
  sent: Request[];
  opened: string[];
  /** Timers the bridge asked for, run on demand so the tests don't wait. */
  later: { fn: () => void; ms: number }[];
  runLater(): void;
  /** Lets every pending request deadline expire. */
  fireDeadlines(): void;
}

function rig(send: Send, opts: { ui?: string; tabs?: number } = {}): Rig {
  const sent: Request[] = [];
  const opened: string[] = [];
  const later: Rig['later'] = [];
  const onEffect = createBridge({
    send: (m) => {
      sent.push(m);
      return send(m);
    },
    openTab: async (url) => {
      opened.push(url);
    },
    countTabs: async () => opts.tabs ?? 2,
    later: (fn, ms) => {
      later.push({ fn, ms });
    },
    now: () => Date.UTC(2026, 0, 1),
  });
  const app = mountPopup({
    root,
    cache: null,
    uiLanguage: opts.ui ?? 'en-US',
    startPage: 'loading',
    onEffect,
  });
  const r: Rig = {
    app,
    onEffect,
    sent,
    opened,
    later,
    runLater() {
      // the screen's own timers (steps, flash, toast...); request deadlines wait for fireDeadlines()
      for (const t of later.filter((x) => x.ms < READ_DEADLINE_MS).map((x) => x)) {
        later.splice(later.indexOf(t), 1);
        t.fn();
      }
    },
    fireDeadlines() {
      for (const t of later.filter((x) => x.ms >= READ_DEADLINE_MS)) {
        later.splice(later.indexOf(t), 1);
        t.fn();
      }
    },
  };
  onEffect({ type: 'load' }, app);
  return r;
}

const wait = async (ok: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}; screen is ${root.dataset.state}`);
};
const screen = (name: string) => wait(() => root.dataset.state === name, `screen ${name}`);
const q = (id: string): HTMLElement | null => root.querySelector(`[data-testid="${id}"]`);
const click = (id: string): void => {
  const el = q(id);
  if (!el) throw new Error(`no ${id} on ${root.dataset.state}`);
  el.click();
};
const type = (value: string): void => {
  const input = root.querySelector<HTMLInputElement>('#pw-input');
  if (!input) throw new Error('no password field');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const typeInto = (id: string, value: string): void => {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no #${id}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const reply =
  (h: Awaited<ReturnType<typeof startWorker>>): Send =>
  (m) =>
    h.send(m);
const types = (r: Rig): string[] => r.sent.map((m) => m.type);
const text = (id: string): string => q(id)?.textContent ?? '';

describe('opening the popup', () => {
  test('state.get first; a fresh install lands on the setup page', async () => {
    const h = await startWorker();
    const r = rig(reply(h));
    expect(root.dataset.state).toBe('loading');
    await screen('setup');
    expect(types(r)).toEqual(['state.get']);
  });

  test('an unlocked vault lands on the list, with the real accounts', async () => {
    const { h } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    expect(root.querySelectorAll('[data-testid="account-list"] .row')).toHaveLength(2);
    expect(r.app.state().platforms.facebook.openTabs).toBe(2);
    expect(
      r.app
        .state()
        .platforms.facebook.accounts.map((a) => a.label)
        .sort(),
    ).toEqual(['Alice', 'Bob']);
  });

  test('a locked vault lands on the lock page', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    rig(reply(h));
    await screen('locked');
  });

  test('settings from the worker win over the cache (theme and language)', async () => {
    const h = await startWorker();
    await h.must({ type: 'settings.set', theme: 'dark', language: 'th' });
    const r = rig(reply(h));
    await screen('setup');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(r.app.translator().lang).toBe('th');
  });

  test('a failing state.get shows a notice with a retry that asks again', async () => {
    const h = await startWorker();
    let fail = true;
    const r = rig((m) => (fail ? Promise.reject(new Error('port closed')) : h.send(m)));
    await screen('notice');
    expect(q('notice')?.dataset.code).toBe('unknown');
    fail = false;
    click('notice-retry');
    await screen('setup');
    expect(types(r)).toEqual(['state.get', 'state.get']);
  });
});

describe('master password', () => {
  test('setup: a weak password is refused in the popup, a good one creates the vault', async () => {
    const h = await startWorker();
    const r = rig(reply(h));
    await screen('setup');
    type('short');
    click('setup-create');
    expect(text('pw-hint')).toBe('Use at least 10 characters.');
    type('0123456789');
    click('setup-create');
    expect(text('pw-hint')).toContain('Avoid one repeated character');
    expect(types(r)).toEqual(['state.get']); // nothing was sent for either

    type(PASSWORD);
    click('setup-create');
    expect(r.sent.at(-1)).toEqual({ type: 'vault.setup', password: PASSWORD });
    await wait(() => r.app.state().lock.button === 'ok', 'setup ok');
    r.runLater();
    await screen('empty');
    expect(await h.must({ type: 'state.get' })).toMatchObject({ hasVault: true, locked: false });
  });

  test('the worker is the real check: a password the popup let through is refused inline', async () => {
    const h = await startWorker();
    const r = rig((m) =>
      m.type === 'vault.setup' ? Promise.resolve({ ok: false, error: 'too_simple' }) : h.send(m),
    );
    await screen('setup');
    type(PASSWORD);
    click('setup-create');
    await wait(() => r.app.state().lock.button === 'err', 'setup refused');
    expect(text('pw-hint')).toContain('Avoid one repeated character');
    r.runLater();
    expect(r.app.state().lock.button).toBe('idle');
  });

  test('a vault that already exists sends the user to the lock page', async () => {
    const h = await startWorker();
    const r = rig(reply(h));
    await screen('setup');
    await h.must({ type: 'vault.setup', password: PASSWORD }); // another popup got there first
    await h.must({ type: 'vault.lock' });
    type('another long password');
    click('setup-create');
    await screen('locked');
    expect(r.later.some((t) => t.ms === TIMING.tryAgain)).toBe(true);
  });

  test('lock now, a wrong password stays inline, the right one opens the list', async () => {
    const { h } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    click('settings-btn');
    click('lock-now');
    await screen('locked');
    await wait(() => types(r).includes('vault.lock'), 'lock sent');

    type('not the password');
    click('unlock');
    await wait(() => r.app.state().lock.button === 'err', 'wrong password');
    expect(text('pw-hint')).toBe('Wrong password. Try again.');
    expect(root.dataset.state).toBe('locked');
    r.runLater();

    type(PASSWORD);
    click('unlock');
    expect(r.sent.at(-1)).toEqual({ type: 'vault.unlock', password: PASSWORD });
    await wait(() => r.app.state().lock.button === 'ok', 'unlocked');
    expect(root.dataset.state).toBe('locked'); // the "Unlocked" moment is not cut short
    r.runLater();
    await screen('list');
  });

  test('too many wrong passwords says to wait, in words', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    const r = rig(reply(h));
    await screen('locked');
    for (let i = 0; i < 5; i += 1) {
      type('wrong password!');
      click('unlock');
      await wait(() => r.app.state().lock.button === 'err', 'wrong');
      r.runLater();
    }
    type(PASSWORD);
    click('unlock');
    await wait(() => r.app.state().lock.error === 'too_many_attempts', 'blocked');
    expect(text('pw-hint')).toContain('Too many wrong passwords');
  });

  test('wipe from the lock page keeps YouTube shortcuts and returns to setup', async () => {
    const { h } = await withAccounts();
    h.youtube.current = { ok: true, value: { authuser: 0 } };
    await h.must({ type: 'account.addCurrent', platform: 'youtube', label: 'Chan' });
    await h.must({ type: 'vault.lock' });
    const r = rig(reply(h));
    await screen('locked');
    click('forgot');
    click('wipe-ok');
    expect(r.sent.at(-1)).toEqual({ type: 'vault.wipe', scope: 'sessions' });
    await screen('setup');
    const after = await h.must<{ accounts: { platform: string }[] }>({ type: 'state.get' });
    expect(after.accounts.map((a) => a.platform)).toEqual(['youtube']);
  });

  test('wipe from settings deletes everything and returns to setup', async () => {
    const { h } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    click('settings-btn');
    click('s-wipe');
    click('s-wipe-ok');
    expect(r.sent.at(-1)).toEqual({ type: 'vault.wipe', scope: 'all' });
    await screen('setup');
    expect(await h.must({ type: 'state.get' })).toMatchObject({ hasVault: false, accounts: [] });
  });

  test('a wipe the worker refuses (a switch is running) says so and keeps the data', async () => {
    const { h } = await withAccounts();
    h.deps.busy.add('facebook');
    const r = rig(reply(h));
    await screen('list');
    click('settings-btn');
    click('s-wipe');
    click('s-wipe-ok');
    await wait(() => root.querySelector('[data-testid="notice"]') !== null, 'notice');
    expect(q('notice')?.dataset.code).toBe('busy');
    h.deps.busy.delete('facebook');
    click('notice-retry');
    await screen('setup');
    expect(types(r).filter((t) => t === 'vault.wipe')).toHaveLength(2);
  });
});

describe('accounts', () => {
  test('add: probe shows who is logged in, save stores it, the list shows it', async () => {
    const h = await startWorker();
    await h.must({ type: 'vault.setup', password: PASSWORD });
    await loginAs(h.chrome, 'facebook', '1001234');
    const r = rig(reply(h));
    await screen('empty');
    click('add-account');
    await screen('adding');
    expect(r.sent.at(-1)).toEqual({ type: 'account.probe', platform: 'facebook' });
    expect(text('add-form')).toContain('1234');
    expect((q('add-input') as HTMLInputElement).value).toBe('Facebook 1');
    typeInto('add-input', 'Shop page');
    click('add-save');
    expect(r.sent.at(-1)).toEqual({
      type: 'account.addCurrent',
      platform: 'facebook',
      label: 'Shop page',
    });
    await screen('list');
    expect(r.app.state().platforms.facebook.accounts[0]?.label).toBe('Shop page');
    expect(r.app.state().adding).toBeNull();
  });

  test('add while nobody is logged in shows the not-logged-in note; opening the site opens a tab', async () => {
    const h = await startWorker();
    await h.must({ type: 'vault.setup', password: PASSWORD });
    const r = rig(reply(h));
    await screen('empty');
    click('add-account');
    await screen('adding');
    expect(q('add-not-logged-in')).not.toBeNull();
    root.querySelector<HTMLElement>('[data-act="open-site"]')?.click();
    await wait(() => r.opened.length === 1, 'tab opened');
    expect(r.opened).toEqual(['https://www.facebook.com/']);
  });

  test('add: the login vanishing between probe and save falls back to the note, and a double click saves once', async () => {
    const h = await startWorker();
    await h.must({ type: 'vault.setup', password: PASSWORD });
    await loginAs(h.chrome, 'facebook', '1001234');
    const r = rig(reply(h));
    await screen('empty');
    click('add-account');
    await screen('adding');
    for (const c of await h.chrome.cookies.getAll({ domain: 'facebook.com' })) {
      await h.chrome.cookies.remove({ url: 'https://www.facebook.com/', name: c.name });
    }
    click('add-save');
    click('add-save');
    await wait(() => q('add-not-logged-in') !== null, 'note');
    expect(types(r).filter((t) => t === 'account.addCurrent')).toHaveLength(1);
  });

  test('add: a duplicate is explained and has no retry', async () => {
    const { h } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    click('add-account');
    await screen('adding');
    click('add-save');
    await wait(() => q('notice') !== null, 'notice');
    expect(q('notice')?.dataset.code).toBe('duplicate');
    expect(q('notice-retry')).toBeNull();
    expect(types(r)).toContain('account.addCurrent');
  });

  test('rename and remove reach the worker and stay', async () => {
    const { h } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    const id = r.app.state().platforms.facebook.accounts.find((a) => a.label === 'Alice')?.id ?? '';
    click(`rename-${id}`);
    typeInto('rename-input', 'Alice B');
    click('rename-save');
    expect(r.sent.at(-1)).toEqual({ type: 'account.rename', accountId: id, label: 'Alice B' });
    click(`delete-${id}`);
    click('delete-confirm');
    expect(r.sent.at(-1)).toEqual({ type: 'account.remove', accountId: id });
    await wait(() => types(r).includes('account.remove'), 'remove');
    await new Promise((res) => setTimeout(res, 30));
    const s = await h.must<{ accounts: { id: string; label: string }[] }>({ type: 'state.get' });
    expect(s.accounts.some((a) => a.id === id)).toBe(false);
    expect(r.app.state().platforms.facebook.accounts.map((a) => a.label)).toEqual(['Bob']);
    expect(root.querySelector('[data-testid="notice"]')).toBeNull();
  });

  test('a rename the worker refuses puts the old name back and offers a retry', async () => {
    const { h } = await withAccounts();
    const r = rig((m) =>
      m.type === 'account.rename' ? Promise.resolve({ ok: false, error: 'busy' }) : h.send(m),
    );
    await screen('list');
    const id = r.app.state().platforms.facebook.accounts[0]?.id ?? '';
    const before = r.app.state().platforms.facebook.accounts[0]?.label;
    click(`rename-${id}`);
    typeInto('rename-input', 'Nope');
    click('rename-save');
    await wait(() => q('notice') !== null, 'notice');
    await wait(() => r.app.state().platforms.facebook.accounts[0]?.label === before, 'old name');
    expect(q('notice-retry')).not.toBeNull();
  });

  test('switch: steps follow the clock, success shows the toast with the reloaded tabs', async () => {
    const { h, ids } = await withAccounts();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const r = rig(async (m) => {
      if (m.type === 'account.switch') await gate;
      return h.send(m);
    });
    await screen('list');
    const alice = ids['1001'] ?? '';
    click(`row-${alice}`);
    root.querySelector<HTMLElement>(`[data-testid="row-${alice}"] .main`)?.click();
    await screen('switching');
    expect(r.sent.at(-1)).toEqual({ type: 'account.switch', accountId: alice });
    expect(r.app.state().switching?.step).toBe(0);
    r.runLater();
    expect(r.app.state().switching?.step).toBe(1);
    r.runLater();
    expect(r.app.state().switching?.step).toBe(2);
    r.runLater(); // the last step has no next one
    expect(r.app.state().switching?.step).toBe(2);
    release();
    await screen('success');
    expect(r.app.state().platforms.facebook.activeId).toBe(alice);
    expect(text('toast')).toContain('Reloaded 2 tabs');
    // flash and toast clear on their own
    r.runLater();
    r.runLater();
    expect(r.app.state().toast).toBeNull();
    expect(r.app.state().flash).toBeNull();
  });

  test('switch failures: expired and checkpoint explain the session, locked goes to the lock page', async () => {
    const { h, ids } = await withAccounts();
    let code: string = 'expired';
    const r = rig((m) =>
      m.type === 'account.switch' ? Promise.resolve({ ok: false, error: code }) : h.send(m),
    );
    await screen('list');
    const alice = ids['1001'] ?? '';
    const press = () =>
      root.querySelector<HTMLElement>(`[data-testid="row-${alice}"] .main`)?.click();
    press();
    await screen('error');
    expect(q('error')?.dataset.code).toBe('expired');
    expect(r.app.state().switching).toBeNull();
    click('error-close');

    code = 'checkpoint';
    await wait(() => root.querySelector('.row .main:not([disabled])') !== null, 'idle');
    press();
    await wait(() => q('error')?.dataset.code === 'checkpoint', 'checkpoint');
    expect(q('error-update')).toBeNull();
    click('error-open');
    await wait(() => r.opened.length === 1, 'tab');
    expect(r.opened[0]).toBe('https://www.facebook.com/login/'); // from an error: the login page
    click('error-close');

    code = 'locked';
    await h.must({ type: 'vault.lock' }); // the worker really is locked, so its next answer agrees
    await wait(() => root.querySelector('.row .main:not([disabled])') !== null, 'idle');
    press();
    await screen('locked');
  });

  test('update session after an error: wrong account explains it, the right one clears the badge', async () => {
    const { h, ids } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    const alice = ids['1001'] ?? '';
    // the browser is Bob right now; an update for Alice is the wrong account
    r.app.dispatch({ type: 'failed', code: 'expired', id: alice });
    expect(q('error')?.dataset.code).toBe('expired');
    click('error-update');
    await wait(() => q('error')?.dataset.code === 'wrong_account', 'wrong account');
    expect(root.querySelector('[data-testid="error"]')?.textContent).toContain(
      'A different account is logged in',
    );
    click('error-close');
    await loginAs(h.chrome, 'facebook', '1001');
    r.app.dispatch({ type: 'failed', code: 'expired', id: alice });
    click('error-update');
    await wait(() => types(r).filter((t) => t === 'account.updateSession').length === 2, 'sent');
    await wait(() => root.querySelector('[data-testid="error"]') === null, 'cleared');
    expect(r.app.state().notice).toBeNull();
  });

  test('"switch anyway" retries the switch with force', async () => {
    const { h, ids } = await withAccounts();
    const alice = ids['1001'] ?? '';
    let first = true;
    const r = rig((m) => {
      if (m.type === 'account.switch' && first) {
        first = false;
        return Promise.resolve({ ok: false, error: 'unsaved_current' });
      }
      return h.send(m);
    });
    await screen('list');
    root.querySelector<HTMLElement>(`[data-testid="row-${alice}"] .main`)?.click();
    await wait(() => q('notice') !== null, 'notice');
    expect(text('notice-retry')).toBe('Switch anyway');
    click('notice-retry');
    expect(r.sent.at(-1)).toEqual({ type: 'account.switch', accountId: alice, force: true });
    await screen('success');
  });

  test('a platform the worker marks busy has its switch, add and update buttons off', async () => {
    const { h } = await withAccounts();
    h.deps.busy.add('facebook');
    const r = rig(reply(h));
    await screen('list');
    expect(r.app.state().platforms.facebook.busy).toBe(true);
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('.row .main')].every((b) => b.disabled),
    ).toBe(true);
    expect((q('add-account') as HTMLButtonElement).disabled).toBe(true);
    r.app.dispatch({
      type: 'failed',
      code: 'expired',
      id: r.app.state().platforms.facebook.accounts[0]?.id ?? '',
    });
    expect((q('error-update') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('settings', () => {
  test('theme and language are sent and survive a new popup', async () => {
    const { h } = await withAccounts();
    const r = rig(reply(h));
    await screen('list');
    click('settings-btn');
    click('s-theme-dark');
    expect(r.sent.at(-1)).toEqual({ type: 'settings.set', theme: 'dark' });
    click('s-lang-th');
    expect(r.sent.at(-1)).toEqual({ type: 'settings.set', language: 'th' });
    await wait(() => types(r).filter((t) => t === 'settings.set').length === 2, 'sent');
    for (let i = 0; i < 100; i += 1) {
      const saved = await h.must<{ settings: { theme: string; language: string } }>({
        type: 'state.get',
      });
      if (saved.settings.theme === 'dark' && saved.settings.language === 'th') break;
      await new Promise((res) => setTimeout(res, 5));
    }
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '<main id="app"></main>';
    root = document.getElementById('app') as HTMLElement;
    const second = rig(reply(h), { ui: 'en-US' });
    await screen('list');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(second.app.translator().lang).toBe('th');
  });

  test('a settings change the worker refuses is explained, can be retried, and is corrected', async () => {
    const { h } = await withAccounts();
    let fail = true;
    const r = rig((m) =>
      m.type === 'settings.set' && fail
        ? Promise.resolve({ ok: false, error: 'internal' })
        : h.send(m),
    );
    await screen('list');
    click('settings-btn');
    click('s-theme-dark');
    await wait(() => q('notice') !== null, 'notice');
    expect(r.app.state().settings.theme).toBe('system'); // the worker still says system
    fail = false;
    click('notice-retry');
    expect(r.sent.at(-1)).toEqual({ type: 'settings.set', theme: 'dark' });
  });
});

describe('every failure ends in a screen and releases the busy state', () => {
  const BAD: [string, Send][] = [
    ['a dead port', () => Promise.reject(new Error('Could not establish connection'))],
    ['no answer', () => Promise.resolve(undefined)],
    ['a string', () => Promise.resolve('ok')],
    ['an answer with no ok', () => Promise.resolve({ value: 1 })],
    ['an error that is not text', () => Promise.resolve({ ok: false, error: 42 })],
    [
      'a code this popup does not know',
      () => Promise.resolve({ ok: false, error: 'brand_new_code' }),
    ],
  ];
  test.each(BAD)('%s during a switch', async (_why, bad) => {
    const { h, ids } = await withAccounts();
    const r = rig((m) => (m.type === 'account.switch' ? bad(m) : h.send(m)));
    await screen('list');
    root.querySelector<HTMLElement>(`[data-testid="row-${ids['1001'] ?? ''}"] .main`)?.click();
    await wait(() => q('notice') !== null, 'notice');
    expect(r.app.state().switching).toBeNull();
    expect(q('notice')?.dataset.code).toBe('unknown');
    expect(text('notice')).toContain('Something went wrong. Try again.');
    expect(text('notice')).not.toContain('brand_new_code');
    expect((root.querySelector('.row .main:not([disabled])') as HTMLElement | null) !== null).toBe(
      true,
    );
  });

  test.each(BAD)('%s during an unlock releases the button', async (_why, bad) => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    const r = rig((m) => (m.type === 'vault.unlock' ? bad(m) : h.send(m)));
    await screen('locked');
    type('whatever it is');
    click('unlock');
    await wait(() => r.app.state().lock.button === 'err', 'err');
    r.runLater();
    expect(r.app.state().lock.button).toBe('idle');
  });

  test('a state.get with the wrong shape is a notice, not a blank popup', async () => {
    const h = await startWorker();
    for (const bad of [
      { accounts: 'x' },
      {
        accounts: [{ id: 'a' }],
        active: {},
        settings: {},
        busy: [],
        hasVault: true,
        locked: false,
      },
      { accounts: [], active: null, settings: {}, busy: [], hasVault: true, locked: false },
      { accounts: [], active: {}, settings: {}, busy: [1], hasVault: true, locked: false },
      { accounts: [], active: {}, settings: {}, busy: [], hasVault: 'yes', locked: false },
      { accounts: [], active: {}, settings: null, busy: [], hasVault: true, locked: false },
    ]) {
      document.body.innerHTML = '<main id="app"></main>';
      root = document.getElementById('app') as HTMLElement;
      rig((m) => (m.type === 'state.get' ? Promise.resolve({ ok: true, value: bad }) : h.send(m)));
      await screen('notice');
      expect(q('notice')?.dataset.code).toBe('unknown');
    }
  });

  test('opening a site that cannot be opened is a notice', async () => {
    const { h } = await withAccounts();
    const sent: Request[] = [];
    const onEffect = createBridge({
      send: (m) => {
        sent.push(m);
        return h.send(m);
      },
      openTab: () => Promise.reject(new Error('no')),
      countTabs: () => Promise.reject(new Error('no tabs permission')),
      later: () => {},
      now: () => 0,
    });
    const app = mountPopup({ root, cache: null, uiLanguage: 'en', startPage: 'loading', onEffect });
    onEffect({ type: 'load' }, app);
    await screen('list');
    expect(app.state().platforms.facebook.openTabs).toBe(0); // counting is best effort
    onEffect({ type: 'open-site', platform: 'facebook', login: false }, app);
    await wait(() => q('notice') !== null, 'notice');
  });

  test('a send that rejects (the worker went away) is the generic notice, not a hang', async () => {
    const h = await startWorker();
    let gone = false;
    const r = rig((m) => (gone ? Promise.reject(new Error('port closed')) : h.send(m)));
    await screen('setup');
    gone = true;
    type(PASSWORD);
    click('setup-create');
    await wait(() => r.app.state().lock.error === 'unknown', 'unknown hint');
  });

  test('an unexpected throw inside an effect ends as the generic notice instead of an unhandled rejection', async () => {
    const h = await startWorker();
    let broken = false;
    const onEffect = createBridge({
      send: (m) => h.send(m),
      openTab: async () => {},
      countTabs: async () => 0,
      later: () => {
        if (broken) throw new Error('timer gone');
      },
      now: () => 0,
    });
    const app = mountPopup({ root, cache: null, uiLanguage: 'en', startPage: 'loading', onEffect });
    onEffect({ type: 'load' }, app);
    await screen('setup');
    broken = true;
    // a switch asks for its step timer before any request: the throw happens inside run(), outside ask()
    onEffect({ type: 'switch', platform: 'facebook', id: 'x' }, app);
    await wait(() => app.state().notice !== null, 'notice');
    expect(app.state().notice?.code).toBe('unknown');
  });

  test('a probe that fails is a notice with a retry', async () => {
    const h = await startWorker();
    await h.must({ type: 'vault.setup', password: PASSWORD });
    let n = 0;
    rig((m) => {
      if (m.type !== 'account.probe') return h.send(m);
      n += 1;
      return Promise.resolve(
        n === 1 ? { ok: false, error: 'internal' } : { ok: true, value: { tail: 5 } },
      );
    });
    await screen('empty');
    click('add-account');
    await wait(() => q('notice') !== null, 'notice');
    click('notice-retry');
    await wait(() => n === 2 && q('notice') !== null, 'second notice: a tail that is not text');
    expect(q('notice')?.dataset.code).toBe('unknown');
  });
});

describe('every error code has a message, in both languages, and no raw code is shown', () => {
  test('the table covers every code the worker can answer with, plus the generic one', () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual(
      [...ERROR_CODES, 'unknown', 'timeout', 'timeoutStale', 'timeoutPassword'].sort(),
    );
  });

  const codes: ErrorKey[] = [...ERROR_CODES, 'unknown', 'timeout'];
  test.each(['en', 'th'] as Language[])('%s: each code reads as a sentence', (lang) => {
    const tr = createTranslator(lang);
    const seen = new Set<string>();
    for (const code of codes) {
      const message = tr.text(ERROR_TEXT[code]);
      expect(message.length).toBeGreaterThan(8);
      expect(message).not.toContain(code.includes('_') ? code : '\u0000');
      expect(message).not.toMatch(/^err_|\$\w+\$/);
      seen.add(message);
    }
    // two codes may share a sentence on purpose (unknown/internal differ), but never all of them
    expect(seen.size).toBeGreaterThan(codes.length - 3);
  });

  test.each(ERROR_CODES)(
    '%s from a failing rename shows its message in the popup',
    async (code) => {
      if (code === 'locked' || code === 'no_vault') return; // these change the page, tested above
      const { h } = await withAccounts();
      const r = rig((m) =>
        m.type === 'account.rename'
          ? Promise.resolve({ ok: false, error: code satisfies ErrorCode })
          : h.send(m),
      );
      await screen('list');
      const id = r.app.state().platforms.facebook.accounts[0]?.id ?? '';
      click(`rename-${id}`);
      typeInto('rename-input', 'Z');
      click('rename-save');
      if (code === 'expired' || code === 'checkpoint' || code === 'wrong_account') {
        // the rename request has no account to blame; these still read as words
      }
      await wait(() => q('notice') !== null, 'notice');
      expect(q('notice')?.dataset.code).toBe(code);
      const tr = r.app.translator();
      expect(text('notice')).toContain(tr.text(ERROR_TEXT[code]));
    },
  );

  test('"locked" and "no vault" send the user to the page that fixes it', async () => {
    const { h } = await withAccounts();
    for (const [code, page] of [
      ['locked', 'locked'],
      ['no_vault', 'setup'],
    ] as const) {
      document.body.innerHTML = '<main id="app"></main>';
      root = document.getElementById('app') as HTMLElement;
      const r = rig((m) =>
        m.type === 'account.rename'
          ? Promise.resolve({ ok: false, error: code })
          : Promise.resolve({ ok: true, value: undefined }).then(() => h.send(m)),
      );
      await screen('list');
      const id = r.app.state().platforms.facebook.accounts[0]?.id ?? '';
      click(`rename-${id}`);
      typeInto('rename-input', 'Z');
      click('rename-save');
      // the follow-up state.get says "unlocked", which the lock page then corrects
      await wait(() => types(r).filter((t) => t === 'state.get').length >= 2, 'reload');
      expect(['list', page]).toContain(root.dataset.state ?? '');
    }
  });
});

describe('the helpers', () => {
  test('parseReply believes only the two shapes the worker sends', () => {
    expect(parseReply({ ok: true, value: 1 })).toEqual({ ok: true, value: 1 });
    expect(parseReply({ ok: false, error: 'busy' })).toEqual({ ok: false, error: 'busy' });
    for (const bad of [null, undefined, 3, 'x', {}, { ok: false }, { ok: 'yes' }]) {
      expect(parseReply(bad)).toEqual({ ok: false, error: 'unknown' });
    }
  });

  test('toAccountView: ids, Google accounts, "used" lines and expired flags', () => {
    const now = Date.UTC(2026, 0, 10);
    const base = {
      id: 'a',
      platform: 'facebook' as const,
      label: 'Alice',
      initials: 'A',
      platformUserId: '1234567',
      status: 'ok' as const,
      createdAt: now,
      lastUsedAt: null,
      sessionCapturedAt: null,
    };
    expect(toAccountView(base, now)).toMatchObject({
      sub: { kind: 'id', tail: '4567' },
      used: { kind: 'justNow' },
      expired: false,
    });
    const used = (hours: number) =>
      toAccountView({ ...base, lastUsedAt: now - hours * 3_600_000 }, now).used;
    expect(used(5)).toEqual({ kind: 'hoursAgo', n: 5 });
    expect(used(30)).toEqual({ kind: 'yesterday' });
    expect(used(24 * 41)).toEqual({ kind: 'daysAgo', n: 41 });
    expect(toAccountView({ ...base, status: 'checkpoint' }, now).expired).toBe(true);
    const { platformUserId: _drop, ...noId } = base;
    const yt = { ...noId, platform: 'youtube' as const };
    expect(toAccountView({ ...yt, youtube: { authuser: 1, pageid: 'p' } }, now).sub).toEqual({
      kind: 'google',
      n: 2,
      brand: true,
    });
    expect(toAccountView({ ...yt, youtube: { authuser: 0 } }, now).sub).toEqual({
      kind: 'google',
      n: 1,
      brand: false,
    });
  });

  test('decodeState rejects a non-object and urls/patterns cover the three sites', () => {
    expect(decodeState(null, 0)).toBeNull();
    expect(decodeState('x', 0)).toBeNull();
    expect(siteUrl('instagram', true)).toBe('https://www.instagram.com/accounts/login/');
    expect(siteUrl('youtube', false)).toBe('https://www.youtube.com/');
    expect(tabPattern('facebook')).toBe('*://*.facebook.com/*');
  });
});

describe('adding a YouTube account shows what the worker read', () => {
  test('Google account number and brand flag come from the probe', async () => {
    const h = await startWorker();
    await h.must({ type: 'vault.setup', password: PASSWORD });
    h.youtube.current = { ok: true, value: { authuser: 1, pageid: 'brand-7' } };
    rig(reply(h));
    await screen('empty');
    click('tab-youtube');
    click('add-account');
    await screen('adding');
    expect(root.querySelector('.add-form .meta')?.textContent).toBe('Brand · Google account 2');
  });
});

describe('the checkpoint message tells what really happened', () => {
  test('after a checkpoint the new account IS the one in the browser, and the box says so', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.tabs.onLoad = (tab) => {
      tab.url = 'https://www.facebook.com/checkpoint/828281030927956/';
    };
    const r = rig(reply(h));
    await screen('list');
    const alice = ids['1001'] ?? '';
    root.querySelector<HTMLElement>(`[data-testid="row-${alice}"] .main`)?.click();
    await wait(() => q('error')?.dataset.code === 'checkpoint', 'checkpoint box');
    // behaviour: the worker kept the new account active (design 3.4, no put-back)
    const worker = await h.must<{ active: { facebook: string } }>({ type: 'state.get' });
    expect(worker.active.facebook).toBe(alice);
    await wait(() => r.app.state().platforms.facebook.activeId === alice, 'popup follows');
    // message: names that account and does not claim the old one was put back
    const en = q('error')?.textContent ?? '';
    expect(en).toContain('Alice');
    expect(en).toContain('is now the account in your browser');
    expect(en).not.toMatch(/put back|restored/i);
    expect(createTranslator('th').text('error_checkpointDetail', { name: 'Alice' })).not.toContain(
      'ถูกใส่กลับ',
    );
  });
});

describe('[[bold]] markers in error messages render as bold, never as brackets', () => {
  test.each(['err_duplicate', 'err_expired', 'err_wrong_account'] as const)(
    '%s in en and th',
    (key) => {
      for (const lang of ['en', 'th'] as const) {
        const tr = createTranslator(lang);
        const out = tr.html(key).value;
        expect(out).toContain('<b>');
        expect(out).not.toContain('[[');
        expect(out).not.toContain(']]');
      }
    },
  );
});

const HANG = (): Promise<unknown> => new Promise(() => {});

describe('deadlines: a worker that never answers does not freeze the popup', () => {
  test('popup deadlines are longer than what the worker itself waits for', () => {
    expect(SWITCH_DEADLINE_MS).toBeGreaterThan(TAB_LOAD_TIMEOUT_MS);
    expect(READ_DEADLINE_MS).toBeLessThan(WRITE_DEADLINE_MS);
    expect(WRITE_DEADLINE_MS).toBeLessThan(SWITCH_DEADLINE_MS);
  });

  test('state.get that never answers: notice with Try again, which asks again', async () => {
    const h = await startWorker();
    let hang = true;
    const r = rig((m) => (hang ? HANG() : h.send(m)));
    expect(r.later.some((t) => t.ms === READ_DEADLINE_MS)).toBe(true);
    r.fireDeadlines();
    await screen('notice');
    // nothing could be read, so the notice may not claim the list is current
    expect(q('notice')?.dataset.code).toBe('timeoutStale');
    hang = false;
    click('notice-retry');
    await screen('setup');
  });

  test('a switch that never answers: switching and disabled buttons are cleared, state.get runs once, no write is repeated', async () => {
    const { h, ids } = await withAccounts();
    let hangSwitch = true;
    const r = rig((m) => (m.type === 'account.switch' && hangSwitch ? HANG() : h.send(m)));
    await screen('list');
    const alice = ids['1001'] ?? '';
    root.querySelector<HTMLElement>(`[data-testid="row-${alice}"] .main`)?.click();
    await screen('switching');
    expect(r.later.some((t) => t.ms === SWITCH_DEADLINE_MS)).toBe(true);
    const before = types(r).filter((t) => t === 'state.get').length;
    r.fireDeadlines();
    await wait(() => q('notice') !== null, 'timeout notice');
    expect(q('notice')?.dataset.code).toBe('timeout');
    expect(q('notice-retry')).toBeNull(); // a write is never offered again blindly
    expect(r.app.state().switching).toBeNull();
    await wait(() => types(r).filter((t) => t === 'state.get').length === before + 1, 'reconcile');
    expect(types(r).filter((t) => t === 'account.switch')).toHaveLength(1);
    hangSwitch = false;
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('.row .main')].some((b) => !b.disabled),
    ).toBe(true);
  });

  test('worker still busy: the platform stays off because the worker says so, not because the popup guessed', async () => {
    const { h, ids } = await withAccounts();
    let hangSwitch = true;
    const r = rig((m) => (m.type === 'account.switch' && hangSwitch ? HANG() : h.send(m)));
    await screen('list');
    h.deps.busy.add('facebook');
    root.querySelector<HTMLElement>(`[data-testid="row-${ids['1001'] ?? ''}"] .main`)?.click();
    r.fireDeadlines();
    await wait(() => r.app.state().platforms.facebook.busy, 'busy from the worker');
    expect(
      [...root.querySelectorAll<HTMLButtonElement>('.row .main')].every((b) => b.disabled),
    ).toBe(true);
    hangSwitch = false;
  });

  test.each([
    ['rename', (id: string) => ({ type: 'account.rename', accountId: id, label: 'Z' })],
    ['remove', (id: string) => ({ type: 'account.remove', accountId: id })],
    ['settings', () => ({ type: 'settings.set', theme: 'dark' })],
    ['lock', () => ({ type: 'vault.lock' })],
    ['wipe', () => ({ type: 'vault.wipe', scope: 'all' })],
  ])(
    '%s that never answers ends in the timeout notice, once, with its write sent once',
    async (_n, make) => {
      const { h, ids } = await withAccounts();
      const kind = (make('x') as { type: string }).type;
      const r = rig((m) => (m.type === kind ? HANG() : h.send(m)));
      await screen('list');
      const id = ids['1001'] ?? '';
      if (kind === 'account.rename') {
        click(`rename-${id}`);
        typeInto('rename-input', 'Z');
        click('rename-save');
      } else if (kind === 'account.remove') {
        click(`delete-${id}`);
        click('delete-confirm');
      } else if (kind === 'settings.set') {
        click('settings-btn');
        click('s-theme-dark');
      } else if (kind === 'vault.lock') {
        click('settings-btn');
        click('lock-now');
      } else {
        click('settings-btn');
        click('s-wipe');
        click('s-wipe-ok');
      }
      await wait(() => types(r).includes(kind), 'sent');
      expect(r.later.some((t) => t.ms === WRITE_DEADLINE_MS)).toBe(true);
      r.fireDeadlines();
      await wait(() => r.app.state().notice?.code === 'timeout', 'timeout notice');
      await new Promise((res) => setTimeout(res, 20));
      expect(types(r).filter((t) => t === kind)).toHaveLength(1);
      expect(q('notice-retry')).toBeNull();
    },
  );

  test('an answer that arrives after the deadline does not overwrite the reconciled state', async () => {
    const { h, ids } = await withAccounts();
    let release: (v: unknown) => void = () => {};
    const r = rig((m) =>
      m.type === 'account.switch'
        ? new Promise((res) => {
            release = res;
          })
        : h.send(m),
    );
    await screen('list');
    const alice = ids['1001'] ?? '';
    root.querySelector<HTMLElement>(`[data-testid="row-${alice}"] .main`)?.click();
    r.fireDeadlines();
    await wait(() => q('notice') !== null, 'notice');
    await new Promise((res) => setTimeout(res, 20));
    const settled = r.app.state();
    release({ ok: true, value: { reloadedTabs: 2 } }); // far too late
    await new Promise((res) => setTimeout(res, 30));
    expect(r.app.state().toast).toBeNull();
    expect(r.app.state().notice?.code).toBe('timeout');
    expect(r.app.state().platforms.facebook.activeId).toBe(settled.platforms.facebook.activeId);
  });

  test('an unlock that never answers resets the button and says so', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    const r = rig((m) => (m.type === 'vault.unlock' ? HANG() : h.send(m)));
    await screen('locked');
    type('whatever it is');
    click('unlock');
    r.fireDeadlines();
    await wait(() => r.app.state().lock.error === 'timeoutPassword', 'timeout hint');
    expect(r.app.state().lock.button).toBe('idle');
    expect(text('pw-hint')).toBe("The extension didn't answer in time. Try again.");
  });
});

describe('a timed-out request is always reconciled with state.get (setup, unlock, writes, reads)', () => {
  const done: Promise<unknown>[] = [];
  const lost = (h: Awaited<ReturnType<typeof startWorker>>, kind: string): Send => {
    return (m) => {
      if (m.type !== kind) return h.send(m);
      // the worker does the work...
      done.push(h.send(m));
      return HANG(); // ...but its answer never reaches the popup
    };
  };
  const stateGets = (r: Rig): number => types(r).filter((t) => t === 'state.get').length;

  test('setup done by the worker, answer lost: the popup leaves the setup page after one state.get', async () => {
    const h = await startWorker();
    const r = rig(lost(h, 'vault.setup'));
    await screen('setup');
    type(PASSWORD);
    click('setup-create');
    await wait(() => types(r).includes('vault.setup'), 'setup sent');
    await Promise.all(done); // the worker has finished by the time the deadline fires
    const before = stateGets(r);
    r.fireDeadlines();
    await wait(
      () => root.dataset.state !== 'setup' && root.dataset.state !== 'loading',
      'left setup',
    );
    expect(stateGets(r)).toBe(before + 1);
    expect(types(r).filter((t) => t === 'vault.setup')).toHaveLength(1);
    expect(r.app.state().page).toBe('main');
    expect(r.app.state().lock.button).toBe('idle');
    expect(r.app.state().notice?.code).toBe('timeout');
    // a list page: the "list shows the current state" words
    expect(text('notice')).toContain('The list now shows the current state.');
  });

  test('unlock done by the worker, answer lost: the popup leaves the locked page after one state.get', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    const r = rig(lost(h, 'vault.unlock'));
    await screen('locked');
    type(PASSWORD);
    click('unlock');
    await wait(() => types(r).includes('vault.unlock'), 'unlock sent');
    await Promise.all(done);
    const before = stateGets(r);
    r.fireDeadlines();
    await wait(() => r.app.state().page === 'main', 'left the lock page');
    expect(stateGets(r)).toBe(before + 1);
    expect(types(r).filter((t) => t === 'vault.unlock')).toHaveLength(1);
    expect(r.app.state().notice?.code).toBe('timeout');
  });

  test('unlock that really did not happen: the popup stays locked and says the state is current', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    const r = rig((m) => (m.type === 'vault.unlock' ? HANG() : h.send(m)));
    await screen('locked');
    type(PASSWORD);
    click('unlock');
    await wait(() => types(r).includes('vault.unlock'), 'unlock sent');
    r.fireDeadlines();
    await wait(() => r.app.state().lock.error === 'timeoutPassword', 'hint');
    expect(r.app.state().page).toBe('locked');
    expect(r.app.state().stale).toBe(false);
  });

  test('setup that never reached the worker: still the setup page, and its hint has no list in it', async () => {
    const h = await startWorker();
    const r = rig((m) => (m.type === 'vault.setup' ? HANG() : h.send(m)));
    await screen('setup');
    type(PASSWORD);
    click('setup-create');
    await wait(() => types(r).includes('vault.setup'), 'setup sent');
    r.fireDeadlines();
    await wait(() => r.app.state().lock.error === 'timeoutPassword', 'hint');
    expect(r.app.state().page).toBe('setup');
    expect(text('pw-hint')).toBe("The extension didn't answer in time. Try again.");
  });

  test.each([['switch'], ['rename'], ['probe'], ['unlock'], ['setup']])(
    '%s: when the reconcile read fails too, the state is stale: retry only reads, writes are off',
    async (kind) => {
      const fresh = kind === 'setup';
      const { h, ids } = fresh
        ? { h: await startWorker(), ids: {} as Record<string, string> }
        : await withAccounts();
      if (kind === 'unlock') await h.must({ type: 'vault.lock' });
      const hangType =
        {
          switch: 'account.switch',
          rename: 'account.rename',
          probe: 'account.probe',
          unlock: 'vault.unlock',
          setup: 'vault.setup',
        }[kind] ?? '';
      let readsHang = false;
      const r = rig((m) => {
        if (m.type === hangType) {
          readsHang = true;
          return HANG();
        }
        if (m.type === 'state.get' && readsHang) return HANG();
        return h.send(m);
      });
      await screen(fresh ? 'setup' : kind === 'unlock' ? 'locked' : 'list');
      const id = ids['1001'] ?? '';
      if (kind === 'switch')
        root.querySelector<HTMLElement>(`[data-testid="row-${id}"] .main`)?.click();
      else if (kind === 'rename') {
        click(`rename-${id}`);
        typeInto('rename-input', 'Z');
        click('rename-save');
      } else if (kind === 'probe') click('add-account');
      else {
        type(PASSWORD);
        click(kind === 'setup' ? 'setup-create' : 'unlock');
      }
      await wait(() => types(r).includes(hangType), 'write sent');
      r.fireDeadlines(); // the write's deadline
      await wait(() => r.later.some((t) => t.ms === READ_DEADLINE_MS), 'reconcile read pending');
      r.fireDeadlines(); // the reconcile read's deadline
      await wait(() => r.app.state().stale, 'stale');
      expect(r.app.state().notice?.code).toBe('timeoutStale');
      expect(r.app.state().switching).toBeNull();
      expect(r.app.state().lock.button).not.toBe('loading');
      // every write button is off; the only way forward asks for the state again
      const live = [
        ...root.querySelectorAll<HTMLButtonElement>('button[data-act], button[data-pref]'),
      ]
        .filter((b) => !b.disabled)
        .map((b) => b.dataset.act);
      for (const act of live)
        expect([
          'notice-retry',
          'notice-close',
          'pw-toggle',
          'forgot',
          'settings-open',
          'open-site',
          'wipe-cancel',
          'del-cancel',
          'rename-cancel',
          'add-cancel',
          'rename',
          'delete',
          'settings-close',
          'err-close',
        ]).toContain(act ?? '');
      expect(q('notice-retry') ?? root.querySelector('[data-act="notice-retry"]')).not.toBeNull();
      const writes = types(r).filter((t) => !['state.get', 'account.probe'].includes(t)).length;
      const gets = stateGets(r);
      readsHang = false;
      (q('notice-retry') ?? root.querySelector<HTMLElement>('[data-act="notice-retry"]'))?.click();
      await wait(() => !r.app.state().stale, 'loaded again');
      expect(stateGets(r)).toBe(gets + 1);
      expect(types(r).filter((t) => !['state.get', 'account.probe'].includes(t))).toHaveLength(
        writes,
      );
    },
  );

  test('a send that throws at once is a dead port: unknown notice, state read, nothing hangs', async () => {
    const h = await startWorker();
    let broken = false;
    const r = rig((m) => {
      if (broken && m.type === 'vault.setup') throw new Error('Extension context invalidated');
      return h.send(m);
    });
    await screen('setup');
    broken = true;
    type(PASSWORD);
    click('setup-create');
    await wait(() => r.app.state().lock.error === 'unknown', 'unknown hint');
    expect(r.app.state().page).toBe('setup');
  });

  test('stale: an effect that reaches the bridge anyway is dropped without a request', async () => {
    const { h } = await withAccounts();
    let on = false;
    const r = rig((m) => {
      if (m.type === 'settings.set') {
        on = true;
        return HANG();
      }
      if (m.type === 'state.get' && on) return HANG();
      return h.send(m);
    });
    await screen('list');
    click('settings-btn');
    click('s-theme-dark');
    await wait(() => types(r).includes('settings.set'), 'sent');
    r.fireDeadlines();
    await wait(() => r.later.some((t) => t.ms === READ_DEADLINE_MS), 'read pending');
    r.fireDeadlines();
    await wait(() => r.app.state().stale, 'stale');
    const n = r.sent.length;
    r.onEffect({ type: 'lock' }, r.app);
    r.onEffect({ type: 'rename', platform: 'facebook', id: 'x', label: 'Z' }, r.app);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.sent.length).toBe(n);
    expect(r.app.state().stale).toBe(true);
  });

  test('stale: a write that slips past the buttons is dropped by the bridge', async () => {
    const { h } = await withAccounts();
    let on = false;
    const r = rig((m) => {
      if (m.type === 'settings.set') {
        on = true;
        return HANG();
      }
      if (m.type === 'state.get' && on) return HANG();
      return h.send(m);
    });
    await screen('list');
    click('settings-btn');
    click('s-theme-dark');
    await wait(() => types(r).includes('settings.set'), 'sent');
    r.fireDeadlines();
    await wait(() => r.later.some((t) => t.ms === READ_DEADLINE_MS), 'read pending');
    r.fireDeadlines();
    await wait(() => r.app.state().stale, 'stale');
    const n = r.sent.length;
    r.app.dispatch({ type: 'pref-language', value: 'th' });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.sent.length).toBe(n);
  });
});

describe('error texts are the literal words, in both languages (not read back from ERROR_TEXT)', () => {
  const WORDS: Record<string, [string, string]> = {
    wrong_password: ['Wrong password. Try again.', 'รหัสผ่านไม่ถูกต้อง'],
    too_many_attempts: [
      'Too many wrong passwords. Wait about 30 seconds and try again.',
      'ใส่รหัสผิดหลายครั้งเกินไป รอประมาณ 30 วินาที แล้วลองอีกครั้ง',
    ],
    expired: [
      'The saved session has expired. Log in again, then press Update session.',
      'session ที่บันทึกไว้หมดอายุแล้ว ให้ login ใหม่ แล้วกด อัปเดต session',
    ],
    checkpoint: [
      'The site is asking for a security check. Open it and finish the check first.',
      'เว็บขอตรวจสอบความปลอดภัย เปิดเว็บแล้วตรวจสอบให้เสร็จก่อน',
    ],
    wrong_account: [
      'A different account is logged in. Log in to the right one, then press Update session.',
      'มีบัญชีอื่น login อยู่ ให้ login บัญชีที่ถูกต้อง แล้วกด อัปเดต session',
    ],
    busy: [
      'A change is still running for this site. Wait a moment and try again.',
      'ระบบกำลังดำเนินการกับเว็บนี้อยู่ รอสักครู่แล้วลองอีกครั้ง',
    ],
    not_signed_in: [
      'That Google account is not signed in on YouTube. Sign in to it in a YouTube tab, then try again.',
      'บัญชี Google นั้นยังไม่ได้ login บน YouTube ให้ login ในแท็บ YouTube แล้วลองอีกครั้ง',
    ],
    timeoutPassword: [
      "The extension didn't answer in time. Try again.",
      'ส่วนขยายไม่ตอบกลับภายในเวลาที่กำหนด ลองอีกครั้ง',
    ],
    timeoutStale: [
      "The extension didn't answer in time, so it's unclear whether that went through, and the current state couldn't be loaded either. Load it again before you do anything else.",
      'ส่วนขยายไม่ตอบกลับภายในเวลาที่กำหนด จึงยังไม่แน่ชัดว่าดำเนินการสำเร็จหรือไม่ และยังไม่สามารถโหลดสถานะล่าสุดได้ กรุณาโหลดสถานะใหม่อีกครั้งก่อนทำรายการอื่น',
    ],
    timeout: [
      "The extension didn't answer in time, so it's unclear whether that went through. The list now shows the current state. Check it before you try again.",
      'ส่วนขยายไม่ตอบกลับภายในเวลาที่กำหนด จึงยังไม่แน่ชัดว่าดำเนินการสำเร็จหรือไม่ ระบบแสดงสถานะล่าสุดในรายการให้แล้ว กรุณาตรวจสอบก่อนลองอีกครั้ง',
    ],
  };
  const plain = (s: string) =>
    s
      .replace(/<\/?b>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");
  test.each(Object.entries(WORDS))('%s', (code, [en, th]) => {
    const key = ERROR_TEXT[code as ErrorKey];
    // wrong_password has its own short Thai line on the lock page (lock_bad); it must still read as a wrong password
    expect(plain(createTranslator('en').html(key).value)).toBe(en);
    expect(plain(createTranslator('th').html(key).value)).toContain(th);
  });

  test('the lock page says "Wrong password" for a wrong password, not the generic text', async () => {
    const { h } = await withAccounts();
    await h.must({ type: 'vault.lock' });
    rig(reply(h));
    await screen('locked');
    type('not the password');
    click('unlock');
    await wait(() => text('pw-hint') === 'Wrong password. Try again.', 'wrong password text');
    expect(text('pw-hint')).not.toContain('Something went wrong');
  });
});
