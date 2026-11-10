// Popup behaviour as a pure reducer: (state, action) → next state, the motion to play, and the effects
// the background worker has to carry out. No DOM, no timers, no chrome.*. B5a only draws and navigates;
// B5b turns `effects` into messages for the service worker and feeds its answers back as the
// "result" actions below.
import { isErrorCode } from '../lib/messages';
import { initialsOf, MAX_LABEL_LENGTH } from '../lib/store';
import { validatePassword } from '../lib/vault';
import type { LanguagePref } from './i18n';
import type { MotionMode } from './motion';
import {
  type AccountProblem,
  type AccountView,
  type ErrorKey,
  emptyPlatform,
  type Platform,
  type PlatformView,
  type PopupState,
  WRITE_ACTIONS,
} from './state';
import type { ThemePref } from './theme';

// --- what the user can do (the data-act values in view.ts) ---

export type UserAction =
  | { type: 'tab'; platform: Platform }
  | { type: 'settings-open' | 'settings-close' }
  | { type: 'pref-theme'; value: ThemePref }
  | { type: 'pref-language'; value: LanguagePref }
  | { type: 'switch' | 'rename' | 'delete' | 'del-ok'; id: string }
  | {
      type:
        | 'rename-cancel'
        | 'rename-save'
        | 'del-cancel'
        | 'add'
        | 'add-cancel'
        | 'add-save'
        | 'err-close'
        | 'err-update'
        | 'open-site'
        | 'unlock'
        | 'setup'
        | 'notice-close'
        | 'notice-retry'
        | 'pw-toggle'
        | 'forgot'
        | 'wipe-cancel'
        | 'wipe-ok'
        | 'lock-now'
        | 's-wipe'
        | 's-wipe-cancel'
        | 's-wipe-ok';
    }
  | { type: 'input'; field: 'rename' | 'add' | 'password'; value: string };

// --- what the background tells the popup (B5b feeds these in) ---

/** Everything state.get tells the popup, already in the popup's own shapes. */
export interface Loaded {
  hasVault: boolean;
  locked: boolean;
  theme: ThemePref;
  language: LanguagePref;
  platforms: Record<Platform, { accounts: AccountView[]; activeId: string | null; busy: boolean }>;
  openTabs: Record<Platform, number>;
  /** An add or an update went through: the form that started it is done. */
  closeForms?: boolean;
}

export type ResultAction =
  | { type: 'loaded'; data: Loaded; closeForms?: boolean }
  /** A request failed: `code` is what the worker said (anything unknown becomes the generic message). */
  | { type: 'failed'; code: string; id?: string; retry?: Effect }
  | { type: 'settings-loaded'; theme: ThemePref; language: LanguagePref; uiLanguage: 'en' | 'th' }
  | { type: 'platform-loaded'; platform: Platform; view: PlatformView }
  | { type: 'switch-step'; step: number }
  | { type: 'switch-done'; ok: boolean; tabs?: number }
  | { type: 'flash-clear' | 'toast-clear' | 'unlock-reset' | 'unlock-done' }
  /** A request timed out: drop what the popup set while waiting (switching, spinner) before the state is fetched. */
  | { type: 'settle' }
  | { type: 'unlock-result'; ok: boolean; code?: string }
  | { type: 'add-probed'; found: { idTail: string; defaultName: string; brand?: boolean } | null }
  | { type: 'locked'; locked: boolean }
  /** account.probe said which saved account the tab under the popup is logged in to (null: none of them). */
  | { type: 'here-account'; platform: Platform; accountId: string | null };

export type PopupAction = UserAction | ResultAction;

export type Effect =
  | { type: 'load' }
  | { type: 'setup'; password: string }
  | { type: 'switch'; platform: Platform; id: string; force?: boolean }
  | { type: 'rename'; platform: Platform; id: string; label: string }
  | { type: 'delete'; platform: Platform; id: string }
  | { type: 'probe-add'; platform: Platform }
  | { type: 'add'; platform: Platform; label: string }
  | { type: 'update-session'; platform: Platform; id: string }
  | { type: 'open-site'; platform: Platform; login: boolean }
  | { type: 'unlock'; password: string }
  | { type: 'lock' }
  | { type: 'wipe'; scope: 'sessions' | 'all' }
  | { type: 'settings'; theme?: ThemePref; language?: LanguagePref };

export interface Step {
  state: PopupState;
  /** Which view transition wraps the redraw. */
  mode: MotionMode;
  /** Slide direction for tab/page changes. */
  dir: 1 | -1;
  /** false = the state changed but nothing needs redrawing (typing in a field). */
  render: boolean;
  effects: Effect[];
}

const PLATFORM_ORDER: readonly Platform[] = ['facebook', 'instagram', 'youtube'];

/** Reads a click target's data-* attributes (see view.ts) into an action. */
export function parseAction(el: HTMLElement): UserAction | null {
  const { act, id, tab, pref, value } = el.dataset;
  if (tab && PLATFORM_ORDER.includes(tab as Platform))
    return { type: 'tab', platform: tab as Platform };
  if (pref === 'theme' && (value === 'system' || value === 'light' || value === 'dark')) {
    return { type: 'pref-theme', value };
  }
  if (pref === 'language' && (value === 'auto' || value === 'en' || value === 'th')) {
    return { type: 'pref-language', value };
  }
  switch (act) {
    case 'switch':
    case 'rename':
    case 'delete':
      return id ? { type: act, id } : null;
    case 'del-ok':
      return id ? { type: 'del-ok', id } : null;
    case 'settings-open':
    case 'settings-close':
    case 'rename-cancel':
    case 'rename-save':
    case 'del-cancel':
    case 'add':
    case 'add-cancel':
    case 'add-save':
    case 'err-close':
    case 'err-update':
    case 'open-site':
    case 'unlock':
    case 'setup':
    case 'notice-close':
    case 'notice-retry':
    case 'pw-toggle':
    case 'forgot':
    case 'wipe-cancel':
    case 'wipe-ok':
    case 'lock-now':
    case 's-wipe':
    case 's-wipe-cancel':
    case 's-wipe-ok':
      return { type: act };
    default:
      return null;
  }
}

/** Drops every transient screen (editor, confirm, toast, error, password text). */
function calm(s: PopupState): PopupState {
  return {
    ...s,
    switching: null,
    flash: null,
    toast: null,
    error: null,
    // a stale state keeps its notice (and the lock hint) through navigation: they hold Try again
    notice: s.stale ? s.notice : null,
    editing: null,
    confirmDelete: null,
    adding: null,
    lock: {
      password: '',
      show: false,
      bad: false,
      wipeConfirm: false,
      button: 'idle',
      error: s.stale ? s.lock.error : null,
    },
    settings: { ...s.settings, wipeConfirm: false },
  };
}

const PROBLEMS: readonly string[] = [
  'expired',
  'checkpoint',
  'wrong_account',
] satisfies AccountProblem[];
const isProblem = (code: ErrorKey): code is AccountProblem => PROBLEMS.includes(code);

/** A code from the worker, or `unknown` when it is not one this popup has a message for. */
export const toErrorKey = (code: string | undefined): ErrorKey =>
  code === 'timeout' || code === 'timeoutStale' ? code : isErrorCode(code) ? code : 'unknown';

const find = (s: PopupState, id: string): AccountView | undefined =>
  s.platforms[s.platform].accounts.find((a) => a.id === id);

function withPlatform(s: PopupState, p: Platform, patch: Partial<PlatformView>): PopupState {
  return { ...s, platforms: { ...s.platforms, [p]: { ...s.platforms[p], ...patch } } };
}

function mapAccounts(s: PopupState, p: Platform, fn: (a: AccountView) => AccountView): PopupState {
  return withPlatform(s, p, { accounts: s.platforms[p].accounts.map(fn) });
}

const same = (state: PopupState, mode: MotionMode = 'none', extra: Partial<Step> = {}): Step => ({
  state,
  mode,
  dir: 1,
  render: true,
  effects: [],
  ...extra,
});

const clipLabel = (v: string): string => [...v.trim()].slice(0, MAX_LABEL_LENGTH).join('');

export function reduce(s: PopupState, a: PopupAction): Step {
  const p = s.platform;
  if (s.stale && WRITE_ACTIONS.has(a.type)) return same(s, 'none', { render: false });
  switch (a.type) {
    case 'tab': {
      if (a.platform === p) return same(s, 'none', { render: false });
      const dir = PLATFORM_ORDER.indexOf(a.platform) > PLATFORM_ORDER.indexOf(p) ? 1 : -1;
      return same({ ...calm(s), platform: a.platform }, 'tab', { dir });
    }
    case 'settings-open':
      return same({ ...calm(s), page: 'settings' }, 'page', { dir: 1 });
    case 'settings-close':
      return same({ ...s, page: 'main', settings: { ...s.settings, wipeConfirm: false } }, 'page', {
        dir: -1,
      });
    case 'pref-theme':
      if (a.value === s.settings.theme) return same(s, 'none', { render: false });
      return same({ ...s, settings: { ...s.settings, theme: a.value } }, 'theme', {
        effects: [{ type: 'settings', theme: a.value }],
      });
    case 'pref-language':
      if (a.value === s.settings.language) return same(s, 'none', { render: false });
      return same({ ...s, settings: { ...s.settings, language: a.value } }, 'lang', {
        effects: [{ type: 'settings', language: a.value }],
      });

    case 'switch':
      return startSwitch(s, a.id, false);
    case 'switch-step':
      return same(s.switching ? { ...s, switching: { ...s.switching, step: a.step } } : s, 'none', {
        render: false,
      });
    case 'switch-done': {
      const sw = s.switching;
      if (!sw) return same(s, 'none', { render: false });
      const acct = find(s, sw.id);
      const base: PopupState = {
        ...s,
        switching: null,
        flash: { id: sw.id, kind: a.ok ? 'ok' : 'bad' },
      };
      if (!a.ok) return same({ ...base, error: { id: sw.id, code: 'expired' } }, 'status');
      const view = s.platforms[p];
      let next: PopupState = base;
      next = mapAccounts(next, p, (x) =>
        x.id === view.activeId
          ? { ...x, used: { kind: 'justNow' } }
          : x.id === sw.id
            ? { ...x, used: { kind: 'now' } }
            : x,
      );
      next = withPlatform(next, p, { activeId: sw.id });
      return same(
        { ...next, toast: { name: acct?.label ?? '', tabs: a.tabs ?? view.openTabs } },
        'status',
      );
    }
    case 'failed':
      return fail(s, a);
    case 'loaded':
      return load(s, a.data, a.closeForms === true);
    case 'settle':
      return same(
        {
          ...s,
          switching: null,
          lock: { ...s.lock, button: s.lock.button === 'loading' ? 'idle' : s.lock.button },
        },
        'status',
      );
    case 'notice-close':
      // while the state is stale the notice carries the only way forward (Try again): it stays
      if (s.stale) return same(s, 'none', { render: false });
      return same({ ...s, notice: null }, 'expand');
    case 'notice-retry':
      return retry(s);
    case 'flash-clear':
      return s.flash ? same({ ...s, flash: null }, 'status') : same(s, 'none', { render: false });
    case 'toast-clear':
      return s.toast ? same({ ...s, toast: null }, 'toast') : same(s, 'none', { render: false });

    case 'rename': {
      const acct = find(s, a.id);
      if (!acct) return same(s, 'none', { render: false });
      return same({ ...calm(s), editing: { id: a.id, value: acct.label, bad: false } }, 'expand');
    }
    case 'rename-cancel':
      return same({ ...s, editing: null }, 'expand');
    case 'rename-save': {
      if (!s.editing) return same(s, 'none', { render: false });
      const label = clipLabel(s.editing.value);
      if (!label) return same({ ...s, editing: { ...s.editing, bad: true } });
      const { id } = s.editing;
      const next = mapAccounts({ ...s, editing: null }, p, (x) =>
        x.id === id ? { ...x, label, initials: initialsOf(label) } : x,
      );
      return same(next, 'expand', { effects: [{ type: 'rename', platform: p, id, label }] });
    }

    case 'delete':
      return find(s, a.id)
        ? same({ ...calm(s), confirmDelete: a.id }, 'expand')
        : same(s, 'none', { render: false });
    case 'del-cancel':
      return same({ ...s, confirmDelete: null }, 'expand');
    case 'del-ok': {
      const view = s.platforms[p];
      const next = withPlatform({ ...s, confirmDelete: null }, p, {
        accounts: view.accounts.filter((x) => x.id !== a.id),
        activeId: view.activeId === a.id ? null : view.activeId,
      });
      return same(next, 'list', { effects: [{ type: 'delete', platform: p, id: a.id }] });
    }

    case 'add':
      return same(calm(s), 'none', {
        render: false,
        effects: [{ type: 'probe-add', platform: p }],
      });
    case 'add-probed':
      return same(
        {
          ...s,
          adding: a.found
            ? {
                kind: 'form',
                value: a.found.defaultName,
                bad: false,
                idTail: a.found.idTail,
                ...(a.found.brand ? { brand: true } : {}),
              }
            : { kind: 'notLoggedIn' },
        },
        'expand',
      );
    case 'add-cancel':
      return same({ ...s, adding: null }, 'expand');
    case 'add-save': {
      if (s.adding?.kind !== 'form') return same(s, 'none', { render: false });
      const label = clipLabel(s.adding.value);
      if (!label) return same({ ...s, adding: { ...s.adding, bad: true } });
      return same(s, 'none', { render: false, effects: [{ type: 'add', platform: p, label }] });
    }

    case 'err-close':
      return same({ ...s, error: null }, 'expand');
    case 'err-update': {
      if (!s.error) return same(s, 'none', { render: false });
      const { id } = s.error;
      const next = mapAccounts({ ...s, error: null }, p, (x) =>
        x.id === id ? { ...x, expired: false, used: { kind: 'updated' } } : x,
      );
      return same(next, 'list', { effects: [{ type: 'update-session', platform: p, id }] });
    }
    case 'open-site':
      return same(s, 'none', {
        render: false,
        effects: [{ type: 'open-site', platform: p, login: s.error !== null }],
      });

    case 'input': {
      if (a.field === 'rename' && s.editing) {
        return same(
          {
            ...s,
            editing: { ...s.editing, value: a.value, bad: s.editing.bad && !a.value.trim() },
          },
          'none',
          { render: false },
        );
      }
      if (a.field === 'add' && s.adding?.kind === 'form') {
        return same(
          { ...s, adding: { ...s.adding, value: a.value, bad: s.adding.bad && !a.value.trim() } },
          'none',
          { render: false },
        );
      }
      if (a.field === 'password') {
        return same(
          { ...s, lock: { ...s.lock, password: a.value, bad: false, error: null } },
          'none',
          {
            render: false,
          },
        );
      }
      return same(s, 'none', { render: false });
    }

    case 'lock-now':
      return same({ ...calm(s), page: 'locked' }, 'page', { dir: 1, effects: [{ type: 'lock' }] });
    case 'locked':
      return same({ ...calm(s), page: a.locked ? 'locked' : 'main' }, 'page', {
        dir: a.locked ? 1 : -1,
      });
    case 'unlock': {
      if (s.lock.button === 'loading') return same(s, 'none', { render: false });
      // the password lives in the state only until the request carries it: the state forgets it at once
      return same(
        { ...s, lock: { ...s.lock, button: 'loading', error: null, password: '' } },
        'status',
        { effects: [{ type: 'unlock', password: s.lock.password }] },
      );
    }
    case 'setup': {
      if (s.lock.button === 'loading') return same(s, 'none', { render: false });
      // The worker is the real check; this only saves a round trip for a password it would refuse.
      const valid = validatePassword(s.lock.password);
      if (!valid.ok) {
        return same({ ...s, lock: { ...s.lock, bad: true, error: valid.error } }, 'status');
      }
      return same(
        { ...s, lock: { ...s.lock, button: 'loading', bad: false, error: null, password: '' } },
        'status',
        {
          effects: [{ type: 'setup', password: s.lock.password }],
        },
      );
    }
    case 'unlock-result': {
      if (a.ok) return same({ ...s, lock: { ...s.lock, button: 'ok' } }, 'status');
      const code = a.code === undefined || a.code === 'wrong_password' ? null : toErrorKey(a.code);
      return same(
        { ...s, lock: { ...s.lock, button: 'err', bad: true, password: '', error: code } },
        'status',
      );
    }
    case 'unlock-reset':
      return same({ ...s, lock: { ...s.lock, button: 'idle' } }, 'status');
    case 'unlock-done':
      return same({ ...calm(s), page: 'main' }, 'page', { dir: -1 });
    case 'pw-toggle':
      return same({ ...s, lock: { ...s.lock, show: !s.lock.show } });
    case 'forgot':
      return same(
        { ...s, lock: { ...s.lock, wipeConfirm: true, bad: false, error: null } },
        'expand',
      );
    case 'wipe-cancel':
      return same({ ...s, lock: { ...s.lock, wipeConfirm: false } }, 'expand');
    case 'wipe-ok': {
      const cleared = clearPlatforms(calm(s), ['facebook', 'instagram']);
      return same({ ...cleared, page: 'main', platform: 'facebook' }, 'page', {
        dir: -1,
        effects: [{ type: 'wipe', scope: 'sessions' }],
      });
    }
    case 's-wipe':
      return same({ ...s, settings: { ...s.settings, wipeConfirm: true } }, 'expand');
    case 's-wipe-cancel':
      return same({ ...s, settings: { ...s.settings, wipeConfirm: false } }, 'expand');
    case 's-wipe-ok': {
      const cleared = clearPlatforms(calm(s), PLATFORM_ORDER);
      return same({ ...cleared, page: 'main', platform: 'facebook' }, 'page', {
        dir: -1,
        effects: [{ type: 'wipe', scope: 'all' }],
      });
    }

    case 'settings-loaded':
      return same({
        ...s,
        settings: { ...s.settings, theme: a.theme, language: a.language, uiLanguage: a.uiLanguage },
      });
    case 'here-account': {
      if (s.here?.platform !== a.platform || s.here.accountId === a.accountId)
        return same(s, 'none', { render: false });
      return same({ ...s, here: { platform: a.platform, accountId: a.accountId } }, 'status');
    }
    case 'platform-loaded': {
      // the new list replaces the old one; an editor or form for it is done
      const changed = a.view.accounts.length !== s.platforms[a.platform].accounts.length;
      return same(
        { ...withPlatform(s, a.platform, a.view), adding: null, editing: null },
        changed ? 'list' : 'none',
      );
    }
  }
}

function startSwitch(s: PopupState, id: string, force: boolean): Step {
  if (s.switching || s.platforms[s.platform].busy || !find(s, id)) {
    return same(s, 'none', { render: false });
  }
  return same({ ...calm(s), switching: { id, step: 0 } }, 'status', {
    effects: [{ type: 'switch', platform: s.platform, id, ...(force ? { force } : {}) }],
  });
}

/** A request failed. Some codes change the page, some explain a session, the rest are said in words. */
function fail(s: PopupState, a: Extract<ResultAction, { type: 'failed' }>): Step {
  const code = toErrorKey(a.code);
  if (code === 'locked') return same({ ...calm(s), page: 'locked' }, 'page', { dir: 1 });
  if (code === 'no_vault') return same({ ...calm(s), page: 'setup' }, 'page', { dir: 1 });
  const sw = s.switching;
  const id = a.id ?? sw?.id;
  const base: PopupState = {
    ...s,
    // a failure before the first answer still has to show: the loading page has no room for it
    page: s.page === 'loading' ? 'main' : s.page,
    switching: null,
    flash: id ? { id, kind: 'bad' } : null,
  };
  if (id && isProblem(code)) return same({ ...base, error: { id, code } }, 'status');
  if (code === 'timeout' || code === 'timeoutStale') {
    // the lock pages have no notice box: the words go under the password field
    const onLock = s.page === 'locked' || s.page === 'setup';
    return same(
      {
        ...base,
        stale: code === 'timeoutStale',
        // a password page has no list: its hint must not point at one
        lock: onLock
          ? { ...s.lock, button: 'idle', error: code === 'timeout' ? 'timeoutPassword' : code }
          : s.lock,
        notice: { code, retry: a.retry ?? null },
      },
      'status',
    );
  }
  return same({ ...base, notice: { code, retry: a.retry ?? null } }, 'status');
}

/** "Try again" on a notice: repeat what failed. */
function retry(s: PopupState): Step {
  // stale: the way out is a read, whatever the notice remembers
  const again = s.notice?.retry ?? (s.stale ? ({ type: 'load' } as const) : null);
  const cleared: PopupState = { ...s, notice: null };
  if (!again) return same(cleared, 'expand');
  if (again.type === 'switch') {
    const next = startSwitch(cleared, again.id, again.force === true);
    return next.effects.length ? next : same(cleared, 'expand');
  }
  if (again.type === 'load') {
    return same(
      { ...cleared, page: cleared.page === 'main' ? 'loading' : cleared.page },
      'status',
      {
        effects: [again],
      },
    );
  }
  return same(cleared, 'expand', { effects: [again] });
}

/** What state.get said replaces the lists, the settings and (when the data is locked or new) the page. */
function load(s: PopupState, d: Loaded, closeForms: boolean): Step {
  const platforms = { ...s.platforms };
  for (const p of PLATFORM_ORDER) {
    platforms[p] = { ...d.platforms[p], openTabs: d.openTabs[p] };
  }
  // keep an open editor, delete confirm or form only when what it points at is still there
  const has = (id: string): boolean => platforms[s.platform].accounts.some((x) => x.id === id);
  // the "Unlocked ✓" moment is not cut short by the lists arriving
  const finishing = s.lock.button === 'ok' || s.lock.button === 'loading';
  let page = s.page;
  if (!d.hasVault) page = 'setup';
  else if (d.locked) page = 'locked';
  else if (!finishing && (page === 'loading' || page === 'locked' || page === 'setup'))
    page = 'main';
  const next: PopupState = {
    ...s,
    page,
    stale: false,
    lock:
      s.lock.error === 'timeout' ||
      s.lock.error === 'timeoutStale' ||
      s.lock.error === 'timeoutPassword'
        ? { ...s.lock, error: null }
        : s.lock,
    platforms,
    settings: { ...s.settings, theme: d.theme, language: d.language },
    adding: closeForms ? null : s.adding,
    editing: !closeForms && s.editing && has(s.editing.id) ? s.editing : null,
    confirmDelete: s.confirmDelete && has(s.confirmDelete) ? s.confirmDelete : null,
    error: s.error && has(s.error.id) ? s.error : null,
  };
  if (page !== s.page) return same(next, 'page', { dir: page === 'main' ? -1 : 1 });
  const changed = PLATFORM_ORDER.some(
    (p) => platforms[p].accounts.length !== s.platforms[p].accounts.length,
  );
  // Nothing differs at all: no redraw, so a caret in a field is not disturbed. Anything that differs (including
  // `stale`, the lock hint and the notice, which the view reads) draws again; comparing the whole state means a
  // field the view starts to read can never be forgotten here.
  return same(next, changed ? 'list' : 'none', {
    render: canonical(next) !== canonical(s),
  });
}

/** JSON with sorted keys: two states are the same when every field is, whatever order it was built in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

function clearPlatforms(s: PopupState, list: readonly Platform[]): PopupState {
  let next = s;
  for (const p of list) next = withPlatform(next, p, { ...emptyPlatform(s.platforms[p].openTabs) });
  return next;
}

export interface EscapeTarget {
  /** What closing the innermost temporary thing means. */
  action: UserAction;
  /** CSS selector of the button that opened it; focus goes back there. */
  focus: string;
}

/**
 * One Esc rule for the whole popup: close the innermost temporary thing (editor, add form or note, delete
 * confirm, error box, wipe confirm) and give focus back to the button that opened it. Null means Esc has
 * nothing to close here (the lock screen, the settings page, a plain list), so the browser's own Esc
 * (closing the popup) is left alone.
 */
export function escapeTarget(s: PopupState): EscapeTarget | null {
  if (s.page === 'loading') return null;
  if (s.page === 'locked') {
    return s.lock.wipeConfirm
      ? { action: { type: 'wipe-cancel' }, focus: '[data-testid="forgot"]' }
      : null;
  }
  if (s.page === 'settings') {
    if (s.settings.wipeConfirm) {
      return { action: { type: 's-wipe-cancel' }, focus: '[data-testid="s-wipe"]' };
    }
    return s.notice && !s.stale
      ? { action: { type: 'notice-close' }, focus: '[data-testid="settings-back"]' }
      : null;
  }
  if (s.switching) return null;
  if (s.editing) {
    return { action: { type: 'rename-cancel' }, focus: `[data-testid="rename-${s.editing.id}"]` };
  }
  if (s.adding) return { action: { type: 'add-cancel' }, focus: '[data-testid="add-account"]' };
  if (s.confirmDelete) {
    return {
      action: { type: 'del-cancel' },
      focus: `[data-testid="delete-${s.confirmDelete}"]`,
    };
  }
  if (s.error) {
    return { action: { type: 'err-close' }, focus: `.row[data-id="${s.error.id}"] .main` };
  }
  if (s.notice && !s.stale) {
    return { action: { type: 'notice-close' }, focus: '[role="tab"][aria-selected="true"]' };
  }
  return null;
}
