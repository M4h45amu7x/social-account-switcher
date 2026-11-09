// The popup wired to the real worker code (the router on the fake browser): every action sends the right
// Request, every answer (and every failure) ends in a screen, and nothing is left busy.
import { beforeEach, expect, test } from 'bun:test';
import type { Request } from '../../src/lib/messages';
import { READ_DEADLINE_MS } from '../../src/lib/timing';
import { type App, mountPopup } from '../../src/popup/app';
import { createBridge } from '../../src/popup/bridge';
import type { Effect, PopupAction } from '../../src/popup/controller';
import { ERROR_TEXT } from '../../src/popup/errors';
import { createTranslator } from '../../src/popup/i18n';
import { PASSWORD, startWorker, withAccounts } from '../fakes/harness';

type Send = (m: Request) => Promise<unknown>;

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<main id="app"></main>';
  document.documentElement.removeAttribute('data-theme');
  root = document.getElementById('app') as HTMLElement;
});

interface Rig {
  bridge: ReturnType<typeof createBridge>;
  app: App;
  sent: Request[];
  opened: string[];
  /** Timers the bridge asked for, run on demand so the tests don't wait. */
  later: { fn: () => void; ms: number }[];
  runLater(): void;
  /** Lets every pending request deadline expire. */
  fireDeadlines(): void;
}

function rig(
  send: Send,
  opts: { ui?: string; tabs?: number; countTabs?: () => Promise<number> } = {},
): Rig {
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
    countTabs: opts.countTabs ?? (async () => opts.tabs ?? 2),
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
    bridge: onEffect,
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
const types = (r: Rig): string[] => r.sent.map((m) => m.type);
const pause = () => new Promise((r) => setTimeout(r, 30));
const HANG = () => new Promise<never>(() => {});
test.each(['setup', 'unlock'] as const)(
  '%s committed but reply lost must reconcile actual vault',
  async (kind) => {
    const h = await startWorker();
    if (kind === 'unlock') {
      await h.must({ type: 'vault.setup', password: PASSWORD });
      await h.must({ type: 'vault.lock' });
    }
    let committed = false;
    const r = rig(async (m) => {
      const v = await h.send(m);
      if (m.type === `vault.${kind}`) {
        committed = true;
        return HANG();
      }
      return v;
    });
    await screen(kind === 'setup' ? 'setup' : 'locked');
    type(PASSWORD);
    click(kind === 'setup' ? 'setup-create' : 'unlock');
    await wait(() => committed, 'commit');
    r.fireDeadlines();
    await pause();
    r.runLater();
    await pause();
    const actual = await h.must<{ hasVault: boolean; locked: boolean }>({ type: 'state.get' });
    expect(types(r).filter((x) => x === `vault.${kind}`)).toHaveLength(1);
    expect(actual).toMatchObject({ hasVault: true, locked: false });
    expect(types(r).filter((x) => x === 'state.get')).toHaveLength(2);
    expect(r.app.state().page).toBe('main');
  },
);
test('reconcile read timeout offers only a read retry, late switch and late read cannot clobber', async () => {
  const { h, ids } = await withAccounts();
  let blockRead = false;
  const releases: ((v: unknown) => void)[] = [];
  const r = rig((m) =>
    m.type === 'account.switch' || (m.type === 'state.get' && blockRead)
      ? new Promise((res) => releases.push(res))
      : h.send(m),
  );
  await screen('list');
  blockRead = true;
  r.app.dispatch({ type: 'switch', id: ids['1001'] ?? '' });
  r.fireDeadlines();
  await pause();
  r.fireDeadlines();
  await pause();
  expect(r.app.state().switching).toBeNull();
  expect(r.app.state().notice?.retry).toEqual({ type: 'load' });
  blockRead = false;
  click('notice-retry');
  await screen('list');
  await pause();
  const settled = JSON.stringify(r.app.state());
  releases[0]?.({ ok: true, value: { reloadedTabs: 999 } });
  releases[1]?.({ ok: false, error: 'locked' });
  await pause();
  expect(JSON.stringify(r.app.state())).toBe(settled);
  expect(types(r).filter((t) => t === 'account.switch')).toHaveLength(1);
});
const effects = [
  { type: 'lock' },
  { type: 'wipe', scope: 'sessions' },
  { type: 'wipe', scope: 'all' },
  { type: 'settings', theme: 'dark' },
  { type: 'rename', platform: 'facebook', id: 'acc-1', label: 'Q' },
  { type: 'delete', platform: 'facebook', id: 'acc-1' },
  { type: 'add', platform: 'facebook', label: 'Q' },
  { type: 'update-session', platform: 'facebook', id: 'acc-1' },
  { type: 'probe-add', platform: 'youtube' },
  { type: 'switch', platform: 'facebook', id: 'acc-1' },
  { type: 'setup', password: PASSWORD },
  { type: 'unlock', password: PASSWORD },
] as const;
for (const effect of effects)
  for (const fails of [false, true])
    test(`uniform ${effect.type} ${'scope' in effect ? effect.scope : ''} reconcile ${fails ? 'stale' : 'fresh'}`, async () => {
      const { h } = await withAccounts();
      let blocked = false;
      const r = rig((m) =>
        m.type === 'state.get' ? (blocked && fails ? HANG() : h.send(m)) : HANG(),
      );
      await screen('list');
      r.sent.length = 0;
      blocked = true;
      r.bridge(effect as Effect, r.app);
      expect(r.sent.length).toBe(1);
      r.fireDeadlines();
      await wait(() => types(r).includes('state.get'), 'reconcile started');
      if (fails) r.fireDeadlines();
      await wait(
        () => r.app.state().notice?.code === (fails ? 'timeoutStale' : 'timeout'),
        'notice',
      );
      expect(types(r)).toHaveLength(2);
      expect(types(r).at(-1)).toBe('state.get');
      expect(r.app.state().stale).toBe(fails);
    });
async function staleRig(page: 'main' | 'settings' | 'locked' | 'setup') {
  const h = await startWorker();
  if (page !== 'setup') await h.must({ type: 'vault.setup', password: PASSWORD });
  if (page === 'locked') await h.must({ type: 'vault.lock' });
  let hang = false;
  const r = rig((m) => (hang ? HANG() : h.send(m)));
  await screen(page === 'setup' ? 'setup' : page === 'locked' ? 'locked' : 'empty');
  if (page === 'settings') click('settings-btn');
  hang = true;
  r.bridge({ type: 'load' }, r.app);
  r.fireDeadlines();
  await wait(() => r.app.state().stale, 'stale');
  return {
    r,
    h,
    restore: () => {
      hang = false;
    },
  };
}
test.each(['setup', 'locked', 'settings'] as const)(
  'stale %s retry same state restores usable DOM',
  async (page) => {
    const { r, restore } = await staleRig(page);
    restore();
    const gets = types(r).filter((x) => x === 'state.get').length;
    click('notice-retry');
    await wait(() => !r.app.state().stale, 'fresh read');
    await pause();
    expect(types(r).filter((x) => x === 'state.get')).toHaveLength(gets + 1);
    if (page === 'settings') expect((q('lock-now') as HTMLButtonElement)?.disabled).toBe(false);
    else expect(q(page === 'setup' ? 'setup-create' : 'unlock')).not.toBeNull();
  },
);
test.each(['main', 'locked', 'setup'] as const)(
  'stale %s Escape preserves read recovery',
  async (page) => {
    const { r } = await staleRig(page);
    const before = types(r).filter((x) => x === 'state.get').length;
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(q('notice-retry')).not.toBeNull();
    click('notice-retry');
    await pause();
    expect(types(r).filter((x) => x === 'state.get')).toHaveLength(before + 1);
  },
);
test('stale bridge and reducer reject every write including direct effect and keyboard', async () => {
  const { r } = await staleRig('setup');
  const n = r.sent.length;
  for (const effect of effects) r.bridge(effect as Effect, r.app);
  for (const type of [
    'switch',
    'del-ok',
    'rename-save',
    'add',
    'add-save',
    'err-update',
    'unlock',
    'setup',
    'lock-now',
    'wipe-ok',
    's-wipe-ok',
    'pref-theme',
    'pref-language',
  ])
    r.app.dispatch({ type, id: 'acc-1', value: 'dark' } as unknown as PopupAction);
  type(PASSWORD);
  root
    .querySelector('input')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await pause();
  expect(r.sent.length).toBe(n);
});
test('stale retry during outstanding read sends only one state.get; late write/read are ignored', async () => {
  const { h, ids } = await withAccounts();
  let mode = 'normal';
  const release: Array<(v: unknown) => void> = [];
  const r = rig((m) => (mode === 'normal' ? h.send(m) : new Promise((res) => release.push(res))));
  await screen('list');
  mode = 'hang';
  r.app.dispatch({ type: 'switch', id: ids['1001'] ?? '' });
  r.fireDeadlines();
  await pause();
  r.fireDeadlines();
  await wait(() => r.app.state().stale, 'stale');
  const before = r.sent.length;
  click('notice-retry');
  for (let i = 0; i < 10; i++) r.app.dispatch({ type: 'notice-retry' });
  await pause();
  expect(r.sent.length).toBe(before + 1);
  release[2]?.(await h.send({ type: 'state.get' }));
  await wait(() => !r.app.state().stale, 'recovered');
  const state = JSON.stringify(r.app.state());
  release[0]?.({ ok: true, value: { reloadedTabs: 55 } });
  release[1]?.({ ok: false, error: 'locked' });
  await pause();
  expect(JSON.stringify(r.app.state())).toBe(state);
});
test.each(['en', 'th'] as const)('timeoutStale literal %s', (lang) => {
  const text = createTranslator(lang).text(ERROR_TEXT.timeoutStale);
  expect(text).toBe(
    lang === 'en'
      ? "The extension didn't answer in time, so it's unclear whether that went through, and the current state couldn't be loaded either. Load it again before you do anything else."
      : 'ส่วนขยายไม่ตอบกลับภายในเวลาที่กำหนด จึงยังไม่แน่ชัดว่าดำเนินการสำเร็จหรือไม่ และยังไม่สามารถโหลดสถานะล่าสุดได้ กรุณาโหลดสถานะใหม่อีกครั้งก่อนทำรายการอื่น',
  );
});

const typeInto = (id: string, value: string): void => {
  const input = root.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no #${id}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

test.each(['setup', 'locked'] as const)(
  'recovery redraw preserves caret while typing %s',
  async (kind) => {
    const { r, restore } = await staleRig(kind);
    restore();
    click('notice-retry');
    typeInto('pw-input', 'abcdefghi');
    const before = root.querySelector<HTMLInputElement>('#pw-input');
    if (!before) throw new Error('no password field');
    before.focus();
    before.setSelectionRange(3, 3);
    await wait(() => !r.app.state().stale, 'recovered');
    await pause();
    const after = root.querySelector<HTMLInputElement>('#pw-input');
    if (!after) throw new Error('no password field after');
    expect(after.value).toBe('abcdefghi');
    expect(after.selectionStart).toBe(3);
    expect(after.selectionEnd).toBe(3);
    expect(document.activeElement).toBe(after);
  },
);
