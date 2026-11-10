// Sample data for tests and the e2e page: the same fake accounts as mockup/popup.html, in both languages
// (account names are user data, so they are not in the message catalogs). Not imported by the shipped popup.
import { initialsOf } from '../lib/store';
import { reduce } from './controller';
import type { Language } from './i18n';
import {
  type AccountView,
  initialState,
  type Platform,
  type PlatformView,
  type PopupState,
} from './state';

export const SEED_NAMES: Record<Language, Record<string, string>> = {
  en: {
    fb1: 'Personal',
    fb2: 'Orange Bakery',
    fb3: 'Client work A',
    yt1: 'Main channel',
    yt2: 'Food reviews',
    yt3: 'Work account',
  },
  th: {
    fb1: 'ส่วนตัว',
    fb2: 'ร้านขนมบ้านส้ม',
    fb3: 'งานลูกค้า A',
    yt1: 'ช่องหลัก',
    yt2: 'ช่องรีวิวของกิน',
    yt3: 'บัญชีงาน',
  },
};

export const SAMPLE_PASSWORD = 'orange-cat-2026';

export function account(
  id: string,
  label: string,
  rest: Omit<AccountView, 'id' | 'label' | 'initials'>,
): AccountView {
  return { id, label, initials: initialsOf(label), ...rest };
}

export function samplePlatforms(lang: Language): Record<Platform, PlatformView> {
  const n = SEED_NAMES[lang];
  const name = (id: string): string => n[id] ?? id;
  return {
    facebook: {
      activeId: 'fb1',
      openTabs: 2,
      busy: false,
      accounts: [
        account('fb1', name('fb1'), {
          sub: { kind: 'id', tail: '4821' },
          used: { kind: 'now' },
          expired: false,
        }),
        account('fb2', name('fb2'), {
          sub: { kind: 'id', tail: '0937' },
          used: { kind: 'hoursAgo', n: 2 },
          expired: false,
        }),
        account('fb3', name('fb3'), {
          sub: { kind: 'id', tail: '5512' },
          used: { kind: 'daysAgo', n: 41 },
          expired: true,
        }),
      ],
    },
    instagram: { activeId: null, openTabs: 1, busy: false, accounts: [] },
    tiktok: { activeId: null, openTabs: 0, busy: false, accounts: [] },
    youtube: {
      activeId: 'yt1',
      openTabs: 3,
      busy: false,
      accounts: [
        account('yt1', name('yt1'), {
          sub: { kind: 'google', n: 1, brand: false },
          used: { kind: 'now' },
          expired: false,
        }),
        account('yt2', name('yt2'), {
          sub: { kind: 'google', n: 1, brand: true },
          used: { kind: 'yesterday' },
          expired: false,
        }),
        account('yt3', name('yt3'), {
          sub: { kind: 'google', n: 2, brand: false },
          used: { kind: 'daysAgo', n: 5 },
          expired: false,
        }),
      ],
    },
  };
}

export const SAMPLE_STATES = [
  'list',
  'empty',
  'add-form',
  'add-not-logged-in',
  'switching',
  'success',
  'error',
  'rename',
  'delete',
  'youtube',
  'locked',
  'locked-wrong',
  'wipe-confirm',
  'settings',
  'settings-wipe',
] as const;
export type SampleName = (typeof SAMPLE_STATES)[number];

/**
 * More screens than the mockup has buttons for. The contrast gate (tests/e2e/contrast.spec.ts) opens these
 * too, so every platform accent and every error variant is measured. They are not compared with the mockup.
 */
export const EXTRA_STATES = [
  'tt-list',
  'tt-empty',
  'tt-error',
  'delete-active',
  'add-bad',
  'rename-bad',
  'ig-form',
  'ig-not-logged-in',
  'yt-list',
  'yt-error',
  'yt-rename',
  'yt-delete',
  'lock-loading',
  'lock-ok',
  'lock-err',
  'loading',
  'setup',
  'setup-short',
  'setup-creating',
  'locked-blocked',
  'checkpoint',
  'wrong-account',
  'notice',
  'notice-unsaved',
  'platform-busy',
] as const;
export type ExtraName = (typeof EXTRA_STATES)[number];

export function baseState(lang: Language): PopupState {
  const s = initialState();
  return { ...s, platforms: samplePlatforms(lang), settings: { ...s.settings, uiLanguage: lang } };
}

function withExpired(s: PopupState, id: string): PopupState {
  const platforms = structuredClone(s.platforms);
  for (const p of Object.values(platforms)) {
    for (const a of p.accounts) if (a.id === id) a.expired = true;
  }
  return { ...s, platforms };
}

/** The state behind each button of the mockup's "Mockup controls" panel, reached through the real reducer. */
export function sampleState(
  name: SampleName | ExtraName,
  lang: Language,
  addDefaultName = '',
): PopupState {
  let s = baseState(lang);
  const go = (a: Parameters<typeof reduce>[1]): void => {
    s = reduce(s, a).state;
  };
  switch (name) {
    case 'tt-empty':
      go({ type: 'tab', platform: 'tiktok' });
      break;
    case 'tt-list':
    case 'tt-error':
      go({ type: 'tab', platform: 'tiktok' });
      s = {
        ...s,
        here: { platform: 'tiktok', accountId: 'tt1' },
        platforms: {
          ...s.platforms,
          tiktok: {
            activeId: 'tt1',
            openTabs: 2,
            busy: false,
            accounts: [
              account('tt1', 'Alice · fixture', {
                sub: { kind: 'id', tail: '0001' },
                used: { kind: 'now' },
                expired: false,
              }),
              account('tt2', 'Bob · fixture', {
                sub: { kind: 'id', tail: '0002' },
                used: { kind: 'justNow' },
                expired: false,
              }),
            ],
          },
        },
      };
      if (name === 'tt-error') go({ type: 'failed', code: 'tiktok_probe_unavailable' });
      break;
    case 'list':
      break;
    case 'empty':
      go({ type: 'tab', platform: 'instagram' });
      break;
    case 'add-form':
      go({ type: 'add-probed', found: { idTail: '3052', defaultName: addDefaultName } });
      break;
    case 'add-not-logged-in':
      go({ type: 'add-probed', found: null });
      break;
    case 'switching':
      go({ type: 'switch', id: 'fb2' });
      break;
    case 'success':
      go({ type: 'switch', id: 'fb2' });
      go({ type: 'switch-done', ok: true });
      break;
    case 'error':
      go({ type: 'switch', id: 'fb3' });
      go({ type: 'switch-done', ok: false });
      break;
    case 'rename':
      go({ type: 'rename', id: 'fb2' });
      break;
    case 'delete':
      go({ type: 'delete', id: 'fb3' });
      break;
    case 'youtube':
      go({ type: 'tab', platform: 'youtube' });
      go({ type: 'switch', id: 'yt3' });
      go({ type: 'switch-done', ok: true });
      break;
    case 'locked':
      go({ type: 'locked', locked: true });
      break;
    case 'locked-wrong':
      go({ type: 'locked', locked: true });
      go({ type: 'unlock-result', ok: false });
      go({ type: 'unlock-reset' });
      break;
    case 'wipe-confirm':
      go({ type: 'locked', locked: true });
      go({ type: 'forgot' });
      break;
    case 'settings':
      go({ type: 'settings-open' });
      break;
    case 'settings-wipe':
      go({ type: 'settings-open' });
      go({ type: 's-wipe' });
      break;
    case 'delete-active':
      go({ type: 'delete', id: 'fb1' });
      break;
    case 'add-bad':
      go({ type: 'add-probed', found: { idTail: '3052', defaultName: '' } });
      go({ type: 'add-save' });
      break;
    case 'rename-bad':
      go({ type: 'rename', id: 'fb2' });
      go({ type: 'input', field: 'rename', value: '' });
      go({ type: 'rename-save' });
      break;
    case 'ig-form':
      go({ type: 'tab', platform: 'instagram' });
      go({ type: 'add-probed', found: { idTail: '7788', defaultName: 'Instagram 1' } });
      break;
    case 'ig-not-logged-in':
      go({ type: 'tab', platform: 'instagram' });
      go({ type: 'add-probed', found: null });
      break;
    case 'yt-list':
      go({ type: 'tab', platform: 'youtube' });
      break;
    case 'yt-error':
      s = withExpired(baseState(lang), 'yt3');
      go({ type: 'tab', platform: 'youtube' });
      go({ type: 'switch', id: 'yt3' });
      go({ type: 'switch-done', ok: false });
      break;
    case 'yt-rename':
      go({ type: 'tab', platform: 'youtube' });
      go({ type: 'rename', id: 'yt2' });
      break;
    case 'yt-delete':
      go({ type: 'tab', platform: 'youtube' });
      go({ type: 'delete', id: 'yt2' });
      break;
    case 'lock-loading':
      go({ type: 'locked', locked: true });
      go({ type: 'unlock' });
      break;
    case 'lock-ok':
      go({ type: 'locked', locked: true });
      go({ type: 'unlock' });
      go({ type: 'unlock-result', ok: true });
      break;
    case 'lock-err':
      go({ type: 'locked', locked: true });
      go({ type: 'unlock' });
      go({ type: 'unlock-result', ok: false });
      break;
    case 'loading':
      s = { ...s, page: 'loading' };
      break;
    case 'setup':
      s = { ...s, page: 'setup' };
      break;
    case 'setup-short':
      s = { ...s, page: 'setup' };
      go({ type: 'input', field: 'password', value: 'short' });
      go({ type: 'setup' });
      break;
    case 'setup-creating':
      s = { ...s, page: 'setup' };
      go({ type: 'input', field: 'password', value: SAMPLE_PASSWORD });
      go({ type: 'setup' });
      break;
    case 'locked-blocked':
      go({ type: 'locked', locked: true });
      go({ type: 'unlock' });
      go({ type: 'unlock-result', ok: false, code: 'too_many_attempts' });
      go({ type: 'unlock-reset' });
      break;
    case 'checkpoint':
      go({ type: 'switch', id: 'fb2' });
      go({ type: 'failed', code: 'checkpoint' });
      break;
    case 'wrong-account':
      go({ type: 'failed', code: 'wrong_account', id: 'fb3' });
      break;
    case 'notice':
      go({ type: 'failed', code: 'busy', retry: { type: 'load' } });
      break;
    case 'notice-unsaved':
      go({ type: 'switch', id: 'fb2' });
      go({
        type: 'failed',
        code: 'unsaved_current',
        retry: { type: 'switch', platform: 'facebook', id: 'fb2', force: true },
      });
      break;
    case 'platform-busy':
      s = {
        ...s,
        platforms: { ...s.platforms, facebook: { ...s.platforms.facebook, busy: true } },
      };
      break;
  }
  return s;
}
