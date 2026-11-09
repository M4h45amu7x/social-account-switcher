// What storage.local holds: the account list, the active account per platform, settings and the
// encrypted vault (docs/design.md 5). Every change is a pure function from one StoreV1 to the next;
// loadStore/saveStore are the only parts that touch storage.
import type { StorageAreaApi } from './ports';
import { err, ok, type Result } from './result';
import type { Vault } from './vault';

export type Platform = 'facebook' | 'instagram' | 'youtube';
export const PLATFORMS: readonly Platform[] = ['facebook', 'instagram', 'youtube'];

export type AccountStatus = 'ok' | 'expired' | 'checkpoint';

export interface Account {
  id: string;
  platform: Platform;
  /** 1–40 characters, chosen by the user. */
  label: string;
  /** Shown in the avatar circle; derived from the label. */
  initials: string;
  /** Facebook c_user or Instagram ds_user_id. */
  platformUserId?: string;
  /** YouTube only: which signed-in Google account and channel. No cookies. */
  youtube?: { authuser: number; pageid?: string };
  status: AccountStatus;
  createdAt: number;
  lastUsedAt: number | null;
  sessionCapturedAt: number | null;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  language: 'auto' | 'en' | 'th';
}

export interface StoreV1 {
  schemaVersion: 1;
  accounts: Account[];
  active: Record<Platform, string | null>;
  /** null until a master password is set. */
  vault: Vault | null;
  settings: Settings;
}

export const STORE_KEY = 'store';
export const MAX_LABEL_LENGTH = 40;
export const DEFAULT_SETTINGS: Readonly<Settings> = { theme: 'system', language: 'auto' };
const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark'];
const LANGUAGES: readonly Settings['language'][] = ['auto', 'en', 'th'];

export function emptyStore(): StoreV1 {
  return {
    schemaVersion: 1,
    accounts: [],
    active: { facebook: null, instagram: null, youtube: null },
    vault: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fills settings saved before they existed (or with unknown values) with the defaults. */
function readSettings(raw: unknown): Settings {
  const s = isRecord(raw) ? raw : {};
  return {
    theme: THEMES.find((t) => t === s.theme) ?? DEFAULT_SETTINGS.theme,
    language: LANGUAGES.find((l) => l === s.language) ?? DEFAULT_SETTINGS.language,
  };
}

/**
 * Turns whatever storage holds into a StoreV1. Nothing stored gives an empty store. A schema this
 * version doesn't know (a newer one, or junk) gives `unknown_schema`, and the caller must not save
 * over it, so a downgrade never deletes data.
 */
export function migrate(raw: unknown): Result<StoreV1, 'unknown_schema'> {
  if (raw === undefined || raw === null) return ok(emptyStore());
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.accounts)) {
    return err('unknown_schema');
  }
  const base = emptyStore();
  const active = isRecord(raw.active) ? raw.active : {};
  for (const p of PLATFORMS) {
    const id = active[p];
    base.active[p] = typeof id === 'string' ? id : null;
  }
  return ok({
    ...base,
    accounts: raw.accounts as Account[],
    vault: isRecord(raw.vault) ? (raw.vault as unknown as Vault) : null,
    settings: readSettings(raw.settings),
  });
}

export async function loadStore(local: StorageAreaApi): Promise<Result<StoreV1, 'unknown_schema'>> {
  return migrate((await local.get(STORE_KEY))[STORE_KEY]);
}

export async function saveStore(local: StorageAreaApi, store: StoreV1): Promise<void> {
  await local.set({ [STORE_KEY]: store });
}

// --- labels ---

/** Trimmed label, or `invalid_label` when it is empty or longer than 40 characters. */
export function normalizeLabel(label: string): Result<string, 'invalid_label'> {
  const trimmed = label.trim().replace(/\s+/g, ' ');
  const length = [...trimmed].length;
  return length >= 1 && length <= MAX_LABEL_LENGTH ? ok(trimmed) : err('invalid_label');
}

// Thai leading vowels (เ แ โ ใ ไ) are written before the consonant they follow in speech, so skip
// them when picking a word's first letter. Same rule as the mockup.
const isBase = (c: string): boolean => /[\p{L}\p{N}]/u.test(c) && !/[เ-ไ]/.test(c);
const isThai = (c: string): boolean => /[฀-๿]/.test(c);

/** Up to two letters for the avatar: one Thai letter, or the first letters of two Latin words. */
export function initialsOf(label: string): string {
  const firsts = label
    .trim()
    .split(/\s+/)
    .map((w) => [...w].find(isBase) ?? '')
    .filter((c) => c !== '');
  const [first, second] = firsts;
  if (first === undefined) return '?';
  if (isThai(first)) return first;
  return (first + (second !== undefined && !isThai(second) ? second : '')).toUpperCase();
}

// --- accounts ---

export interface NewAccount {
  platform: Platform;
  label: string;
  platformUserId?: string;
  youtube?: { authuser: number; pageid?: string };
}

function sameAccount(a: Account, b: NewAccount): boolean {
  if (a.platform !== b.platform) return false;
  if (b.platform === 'youtube') {
    return a.youtube?.authuser === b.youtube?.authuser && a.youtube?.pageid === b.youtube?.pageid;
  }
  return b.platformUserId !== undefined && a.platformUserId === b.platformUserId;
}

export function findAccount(store: StoreV1, id: string): Account | undefined {
  return store.accounts.find((a) => a.id === id);
}

export function addAccount(
  store: StoreV1,
  input: NewAccount,
  deps: { id: string; now: number },
): Result<{ store: StoreV1; account: Account }, 'duplicate' | 'invalid_label'> {
  const label = normalizeLabel(input.label);
  if (!label.ok) return label;
  if (store.accounts.some((a) => sameAccount(a, input))) return err('duplicate');
  const account: Account = {
    id: deps.id,
    platform: input.platform,
    label: label.value,
    initials: initialsOf(label.value),
    status: 'ok',
    createdAt: deps.now,
    lastUsedAt: null,
    sessionCapturedAt: null,
  };
  if (input.platformUserId !== undefined) account.platformUserId = input.platformUserId;
  if (input.youtube) account.youtube = { ...input.youtube };
  return ok({ store: { ...store, accounts: [...store.accounts, account] }, account });
}

export type AccountPatch = Partial<Pick<Account, 'status' | 'lastUsedAt' | 'sessionCapturedAt'>>;

function replaceAccount(
  store: StoreV1,
  id: string,
  change: (a: Account) => Account,
): Result<StoreV1, 'not_found'> {
  if (!findAccount(store, id)) return err('not_found');
  return ok({ ...store, accounts: store.accounts.map((a) => (a.id === id ? change(a) : a)) });
}

export function renameAccount(
  store: StoreV1,
  id: string,
  label: string,
): Result<StoreV1, 'not_found' | 'invalid_label'> {
  const normalized = normalizeLabel(label);
  if (!normalized.ok) return normalized;
  return replaceAccount(store, id, (a) => ({
    ...a,
    label: normalized.value,
    initials: initialsOf(normalized.value),
  }));
}

export function updateAccount(
  store: StoreV1,
  id: string,
  patch: AccountPatch,
): Result<StoreV1, 'not_found'> {
  return replaceAccount(store, id, (a) => ({ ...a, ...patch }));
}

/** Removes the account and, if it was active, leaves its platform with no active account. */
export function removeAccount(store: StoreV1, id: string): Result<StoreV1, 'not_found'> {
  const account = findAccount(store, id);
  if (!account) return err('not_found');
  const active = { ...store.active };
  if (active[account.platform] === id) active[account.platform] = null;
  return ok({ ...store, accounts: store.accounts.filter((a) => a.id !== id), active });
}

export function setActive(
  store: StoreV1,
  platform: Platform,
  id: string | null,
): Result<StoreV1, 'not_found'> {
  if (id !== null && findAccount(store, id)?.platform !== platform) return err('not_found');
  return ok({ ...store, active: { ...store.active, [platform]: id } });
}

export function updateSettings(
  store: StoreV1,
  patch: Partial<Settings>,
): Result<StoreV1, 'invalid_setting'> {
  const next = { ...store.settings, ...patch };
  if (!THEMES.includes(next.theme) || !LANGUAGES.includes(next.language)) {
    return err('invalid_setting');
  }
  return ok({ ...store, settings: next });
}
