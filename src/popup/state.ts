// What the popup knows how to draw. The view only reads these types; the background worker
// (src/lib/messages.ts) has its own wire types, and B5b maps one onto the other.
import type { Platform } from '../lib/store';
import type { Language, LanguagePref } from './i18n';
import type { ThemePref } from './theme';

export type { Platform };

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
}

export type AddView =
  | { kind: 'form'; value: string; bad: boolean; idTail: string }
  | { kind: 'notLoggedIn' };

export type UnlockButton = 'idle' | 'loading' | 'ok' | 'err';

export interface LockView {
  password: string;
  show: boolean;
  bad: boolean;
  wipeConfirm: boolean;
  button: UnlockButton;
}

export interface SettingsView {
  theme: ThemePref;
  language: LanguagePref;
  /** The language the browser UI reports, shown in "Auto follows the browser language (now: English)". */
  uiLanguage: Language;
  wipeConfirm: boolean;
}

export type Page = 'main' | 'settings' | 'locked';

export interface PopupState {
  page: Page;
  platform: Platform;
  platforms: Record<Platform, PlatformView>;
  /** One switch in progress. `step` is the index of the step being worked on. */
  switching: { id: string; step: number } | null;
  /** The result badge shown for a moment in the row's right-hand slot. */
  flash: { id: string; kind: 'ok' | 'bad' } | null;
  toast: { name: string; tabs: number } | null;
  /** The expired-session note. */
  error: { id: string } | null;
  editing: { id: string; value: string; bad: boolean } | null;
  confirmDelete: string | null;
  adding: AddView | null;
  lock: LockView;
  settings: SettingsView;
}

/** Name of the screen, for `data-state` on the popup root (tests and screenshots use it). */
export type ScreenName =
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
  if (s.page === 'locked') return 'locked';
  if (s.page === 'settings') return 'settings';
  if (s.switching) return 'switching';
  if (s.error) return 'error';
  if (s.confirmDelete) return 'delete';
  if (s.editing) return 'rename';
  if (s.adding) return 'adding';
  if (s.toast) return 'success';
  return s.platforms[s.platform].accounts.length ? 'list' : 'empty';
}

export function emptyPlatform(openTabs = 0): PlatformView {
  return { accounts: [], activeId: null, openTabs };
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
    editing: null,
    confirmDelete: null,
    adding: null,
    lock: { password: '', show: false, bad: false, wipeConfirm: false, button: 'idle' },
    settings: { theme: 'system', language: 'auto', uiLanguage: 'en', wipeConfirm: false },
  };
}
