// Popup behaviour as a pure reducer: (state, action) → next state, the motion to play, and the effects
// the background worker has to carry out. No DOM, no timers, no chrome.*. B5a only draws and navigates;
// B5b turns `effects` into messages for the service worker and feeds its answers back as the
// "result" actions below.
import { initialsOf, MAX_LABEL_LENGTH } from '../lib/store';
import type { LanguagePref } from './i18n';
import type { MotionMode } from './motion';
import {
  type AccountView,
  emptyPlatform,
  type Platform,
  type PlatformView,
  type PopupState,
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

export type ResultAction =
  | { type: 'settings-loaded'; theme: ThemePref; language: LanguagePref; uiLanguage: 'en' | 'th' }
  | { type: 'platform-loaded'; platform: Platform; view: PlatformView }
  | { type: 'switch-step'; step: number }
  | { type: 'switch-done'; ok: boolean }
  | { type: 'flash-clear' | 'toast-clear' | 'unlock-reset' | 'unlock-done' }
  | { type: 'unlock-result'; ok: boolean }
  | { type: 'add-probed'; found: { idTail: string; defaultName: string } | null }
  | { type: 'locked'; locked: boolean };

export type PopupAction = UserAction | ResultAction;

export type Effect =
  | { type: 'switch'; platform: Platform; id: string }
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
    editing: null,
    confirmDelete: null,
    adding: null,
    lock: { password: '', show: false, bad: false, wipeConfirm: false, button: 'idle' },
    settings: { ...s.settings, wipeConfirm: false },
  };
}

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

    case 'switch': {
      if (s.switching || !find(s, a.id)) return same(s, 'none', { render: false });
      return same({ ...calm(s), switching: { id: a.id, step: 0 } }, 'status', {
        effects: [{ type: 'switch', platform: p, id: a.id }],
      });
    }
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
      if (!a.ok) return same({ ...base, error: { id: sw.id } }, 'status');
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
      return same({ ...next, toast: { name: acct?.label ?? '', tabs: view.openTabs } }, 'status');
    }
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
            ? { kind: 'form', value: a.found.defaultName, bad: false, idTail: a.found.idTail }
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
        return same({ ...s, lock: { ...s.lock, password: a.value, bad: false } }, 'none', {
          render: false,
        });
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
      return same({ ...s, lock: { ...s.lock, button: 'loading' } }, 'status', {
        effects: [{ type: 'unlock', password: s.lock.password }],
      });
    }
    case 'unlock-result':
      return a.ok
        ? same({ ...s, lock: { ...s.lock, button: 'ok' } }, 'status')
        : same({ ...s, lock: { ...s.lock, button: 'err', bad: true, password: '' } }, 'status');
    case 'unlock-reset':
      return same({ ...s, lock: { ...s.lock, button: 'idle' } }, 'status');
    case 'unlock-done':
      return same({ ...calm(s), page: 'main' }, 'page', { dir: -1 });
    case 'pw-toggle':
      return same({ ...s, lock: { ...s.lock, show: !s.lock.show } });
    case 'forgot':
      return same({ ...s, lock: { ...s.lock, wipeConfirm: true, bad: false } }, 'expand');
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
  if (s.page === 'locked') {
    return s.lock.wipeConfirm
      ? { action: { type: 'wipe-cancel' }, focus: '[data-testid="forgot"]' }
      : null;
  }
  if (s.page === 'settings') {
    return s.settings.wipeConfirm
      ? { action: { type: 's-wipe-cancel' }, focus: '[data-testid="s-wipe"]' }
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
  return null;
}
