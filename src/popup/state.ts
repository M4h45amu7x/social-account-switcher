// What the popup knows how to draw. The view only reads these types; the background worker
// (src/lib/messages.ts) has its own wire types, and B5b maps one onto the other.
import type { ErrorCode } from '../lib/messages';
import type { Platform } from '../lib/store';
import type { Effect } from './controller';
import type { Language, LanguagePref } from './i18n';
import type { ThemePref } from './theme';

export type { Platform };

/** A code the worker answered with, or `unknown` for anything else (a dead port, a reply that makes no sense). */
export type ErrorKey = ErrorCode | 'unknown' | 'timeout' | 'timeoutStale' | 'timeoutPassword';

/** The small grey text after the account name. */
export type SubLine = { kind: 'id'; tail: string } | { kind: 'google'; n: number; brand: boolean };

/** "Used 2 h ago" and friends. */
export type UsedLine =
  | { kind: 'now' | 'justNow' | 'yesterday' | 'updated' }
  | { kind: 'hoursAgo' | 'daysAgo'; n: number };

export interface AccountView {
  id: string;
  label: string;
  initials: string;
  sub: SubLine;
  used: UsedLine;
  /** The saved session no longer works (shows the "Log in again" chip). */
  expired: boolean;
}

export interface PlatformView {
  accounts: AccountView[];
  activeId: string | null;
  /** Open browser tabs of this site, used in "Reloading 2 tabs". */
  openTabs: number;
  /** The worker is switching or saving on this platform: its switch, add and update buttons stay off. */
  busy: boolean;
}

export type AddView =
  | { kind: 'form'; value: string; bad: boolean; idTail: string; brand?: boolean }
  | { kind: 'notLoggedIn' };

export type UnlockButton = 'idle' | 'loading' | 'ok' | 'err';

export interface LockView {
  password: string;
  show: boolean;
  bad: boolean;
  wipeConfirm: boolean;
  button: UnlockButton;
  /** Why the worker refused the password (too many tries, damaged data...). Wrong password is just `bad`. */
  error: ErrorKey | null;
}

export interface SettingsView {
  theme: ThemePref;
  language: LanguagePref;
  /** The language the browser UI reports, shown in "Auto follows the browser language (now: English)". */
  uiLanguage: Language;
  wipeConfirm: boolean;
}

/** `loading` is the moment before the worker has said what it holds; `setup` asks for the first master password. */
export type Page = 'main' | 'settings' | 'locked' | 'setup' | 'loading';

/** Sessions the box under the tabs can explain, each with its own way forward. */
export type AccountProblem = 'expired' | 'checkpoint' | 'wrong_account';

export interface PopupState {
  page: Page;
  platform: Platform;
  platforms: Record<Platform, PlatformView>;
  /** One switch in progress. `step` is the index of the step being worked on. */
  switching: { id: string; step: number } | null;
  /** The result badge shown for a moment in the row's right-hand slot. */
  flash: { id: string; kind: 'ok' | 'bad' } | null;
  toast: { name: string; tabs: number } | null;
  /** The account-session note (expired, security check, wrong account). */
  error: { id: string; code: AccountProblem } | null;
  /** Any other failure, in words, with a retry when repeating it makes sense. */
  notice: { code: ErrorKey; retry: Effect | null } | null;
  /** The extension did not answer and the current state could not be loaded either: every write stays off until a load works. */
  stale: boolean;
  editing: { id: string; value: string; bad: boolean } | null;
  confirmDelete: string | null;
  adding: AddView | null;
  lock: LockView;
  settings: SettingsView;
}

/** Name of the screen, for `data-state` on the popup root (tests and screenshots use it). */
export type ScreenName =
  | 'loading'
  | 'setup'
  | 'notice'
  | 'locked'
  | 'settings'
  | 'switching'
  | 'error'
  | 'delete'
  | 'rename'
  | 'adding'
  | 'success'
  | 'list'
  | 'empty';

export function screenOf(s: PopupState): ScreenName {
  if (s.page === 'loading') return 'loading';
  if (s.page === 'setup') return 'setup';
  if (s.page === 'locked') return 'locked';
  if (s.page === 'settings') return 'settings';
  if (s.switching) return 'switching';
  if (s.error) return 'error';
  if (s.notice) return 'notice';
  if (s.confirmDelete) return 'delete';
  if (s.editing) return 'rename';
  if (s.adding) return 'adding';
  if (s.toast) return 'success';
  return s.platforms[s.platform].accounts.length ? 'list' : 'empty';
}

export function emptyPlatform(openTabs = 0): PlatformView {
  return { accounts: [], activeId: null, openTabs, busy: false };
}

export function initialState(): PopupState {
  return {
    page: 'main',
    platform: 'facebook',
    platforms: {
      facebook: emptyPlatform(),
      instagram: emptyPlatform(),
      youtube: emptyPlatform(),
    },
    switching: null,
    flash: null,
    toast: null,
    error: null,
    notice: null,
    stale: false,
    editing: null,
    confirmDelete: null,
    adding: null,
    lock: {
      password: '',
      show: false,
      bad: false,
      wipeConfirm: false,
      button: 'idle',
      error: null,
    },
    settings: { theme: 'system', language: 'auto', uiLanguage: 'en', wipeConfirm: false },
  };
}

/** What changes data or asks the worker to. While the state is stale none of it runs. */
export const WRITE_ACTIONS: ReadonlySet<string> = new Set([
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
]);
