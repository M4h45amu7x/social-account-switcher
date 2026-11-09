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
  | { type: 'vault.wipe' }
  | { type: 'settings.set'; theme?: Settings['theme']; language?: Settings['language'] }
  | { type: 'account.addCurrent'; platform: Platform; label: string }
  | { type: 'account.updateSession'; accountId: string }
  | { type: 'account.rename'; accountId: string; label: string }
  | { type: 'account.remove'; accountId: string }
  | { type: 'account.switch'; accountId: string; force?: boolean };

export type RequestType = Request['type'];

/** Longest string field accepted. Labels are checked again (1–40 characters) by the store. */
export const MAX_FIELD_LENGTH = 1024;

type FieldCheck = (v: unknown) => boolean;
const text: FieldCheck = (v) => typeof v === 'string' && v.length <= MAX_FIELD_LENGTH;
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
  'vault.wipe': {},
  'settings.set': {
    theme: [oneOf(['system', 'light', 'dark']), false],
    language: [oneOf(['auto', 'en', 'th']), false],
  },
  'account.addCurrent': { platform: [oneOf(PLATFORMS), true], label: [text, true] },
  'account.updateSession': { accountId: [nonEmpty, true] },
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
    const field = shape[key];
    if (!field) return err('bad_request');
    if (message[key] === undefined && !field[1]) continue;
    if (!field[0](message[key])) return err('bad_request');
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
