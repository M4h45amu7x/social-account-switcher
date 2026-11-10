// The messages the popup may send to the service worker, and the checks the worker runs on every one
// (docs/design.md 8.2). The worker always answers with a Result.
import type { MessageSender } from './ports';
import { err, ok, type Result } from './result';
import { PLATFORMS, type Platform, type Settings } from './store';

export type Request =
  | { type: 'state.get' }
  | { type: 'vault.unlock'; password: string }
  | { type: 'vault.lock' }
  | { type: 'vault.setup'; password: string }
  /** `sessions` keeps the YouTube shortcuts (they hold no session); `all` (the default) deletes everything. */
  | { type: 'vault.wipe'; scope?: 'sessions' | 'all' }
  | { type: 'settings.set'; theme?: Settings['theme']; language?: Settings['language'] }
  /** Who is logged in on a platform right now, without saving anything. `tail` is null when nobody is. */
  | { type: 'account.probe'; platform: Platform; tabId?: number }
  | { type: 'account.addCurrent'; platform: Platform; label: string; tabId?: number }
  | { type: 'account.updateSession'; accountId: string; tabId?: number }
  | { type: 'account.rename'; accountId: string; label: string }
  | { type: 'account.remove'; accountId: string }
  | { type: 'account.switch'; accountId: string; force?: boolean };

export type RequestType = Request['type'];

/**
 * Every error code the worker can answer with, for every request. The router's answers are typed with
 * this union, so a new code that is not listed here fails the typecheck; the popup maps each one to a
 * message (src/popup/errors.ts), so one that has no message fails it too.
 */
export const ERROR_CODES = [
  // the message itself
  'bad_request',
  'forbidden',
  'internal',
  // the saved data
  'store_unreadable',
  'not_found',
  'invalid_label',
  'invalid_setting',
  'duplicate',
  // the master password
  'no_vault',
  'vault_exists',
  'locked',
  'wrong_password',
  'too_many_attempts',
  'too_short',
  'too_simple',
  'unsupported_vault',
  // a switch, a save or an update
  'busy',
  'expired',
  'checkpoint',
  'unsaved_current',
  'wrong_account',
  'not_logged_in',
  'tiktok_disabled',
  'no_tiktok_tab',
  'tiktok_permission',
  'tiktok_probe_unavailable',
  'rollback_failed',
  // YouTube
  'no_youtube_tab',
  'not_signed_in',
  'invalid_session',
  'invalid_tab',
  'api_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const isErrorCode = (v: unknown): v is ErrorCode =>
  typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);

/** Longest string field accepted. Labels are checked again (1–40 characters) by the store. */
export const MAX_FIELD_LENGTH = 1024;

type FieldCheck = (v: unknown) => boolean;
const text: FieldCheck = (v) => typeof v === 'string' && v.length <= MAX_FIELD_LENGTH;
const tabId: FieldCheck = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nonEmpty: FieldCheck = (v) => text(v) && v !== '';
const oneOf =
  (values: readonly unknown[]): FieldCheck =>
  (v) =>
    values.includes(v);

/** Each type's fields: true = required, false = optional. No other field is allowed. */
const SHAPES: Record<RequestType, Record<string, [FieldCheck, boolean]>> = {
  'state.get': {},
  'vault.unlock': { password: [nonEmpty, true] },
  'vault.lock': {},
  'vault.setup': { password: [nonEmpty, true] },
  'vault.wipe': { scope: [oneOf(['sessions', 'all']), false] },
  'settings.set': {
    theme: [oneOf(['system', 'light', 'dark']), false],
    language: [oneOf(['auto', 'en', 'th']), false],
  },
  'account.probe': { platform: [oneOf(PLATFORMS), true], tabId: [tabId, false] },
  'account.addCurrent': {
    platform: [oneOf(PLATFORMS), true],
    label: [text, true],
    tabId: [tabId, false],
  },
  'account.updateSession': { accountId: [nonEmpty, true], tabId: [tabId, false] },
  'account.rename': { accountId: [nonEmpty, true], label: [text, true] },
  'account.remove': { accountId: [nonEmpty, true] },
  'account.switch': { accountId: [nonEmpty, true], force: [(v) => typeof v === 'boolean', false] },
};

/** Accepts only a plain object whose type is known and whose fields match that type exactly. */
export function parseRequest(raw: unknown): Result<Request, 'bad_request'> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err('bad_request');
  if (Object.getPrototypeOf(raw) !== Object.prototype) return err('bad_request');
  const message = raw as Record<string, unknown>;
  const type = message.type;
  if (typeof type !== 'string' || !Object.hasOwn(SHAPES, type)) return err('bad_request');
  const shape = SHAPES[type as RequestType];
  for (const key of Object.keys(message)) {
    if (key === 'type') continue;
    // Own keys only: `constructor`, `toString` or `__proto__` must not find Object.prototype.
    if (!Object.hasOwn(shape, key)) return err('bad_request');
    // Present: hasOwn just checked it.
    const [check, required] = shape[key] as [FieldCheck, boolean];
    if (message[key] === undefined && !required) continue;
    if (!check(message[key])) return err('bad_request');
  }
  for (const [key, [, required]] of Object.entries(shape)) {
    if (required && !Object.hasOwn(message, key)) return err('bad_request');
  }
  return ok(message as Request);
}

/**
 * True only for a page of this extension (the popup, also when it is opened in a tab): the same
 * extension ID and a chrome-extension:// URL of this extension. A content script would carry our ID
 * too, but its URL is the web page's, so it is refused (this extension has no content scripts).
 */
export function isTrustedSender(sender: MessageSender, extensionId: string): boolean {
  return (
    extensionId !== '' &&
    sender.id === extensionId &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${extensionId}/`)
  );
}
