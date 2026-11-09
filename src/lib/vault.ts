// Password-based encryption of the saved sessions (docs/design.md 5 and 6).
// PBKDF2-SHA-256 with 600,000 iterations derives an AES-GCM-256 key. The extractable key only exists
// inside createVault() and unlock(), long enough to export it; everything else uses the
// non-extractable key from importSessionKey().
import type { StoredCookie } from './cookies';
import { err, ok, type Result } from './result';

export type SessionMap = Record<string, { capturedAt: number; cookies: StoredCookie[] }>;

export interface Vault {
  /** `iterations` is read back on unlock, so a later version can raise it without breaking old vaults. */
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  /** Base64 of the 12-byte IV of `ciphertext`. New on every write. */
  iv: string;
  /** Base64 of AES-GCM(JSON of the SessionMap). */
  ciphertext: string;
  /** Base64 of IV + AES-GCM(CHECK_TEXT), so a wrong password is caught without decrypting `ciphertext`. */
  check: string;
}

export const PBKDF2_ITERATIONS = 600000;
/** unlock() refuses a vault outside these bounds instead of deriving with a weak or absurd count. */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
export const MIN_PASSWORD_LENGTH = 10;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CHECK_TEXT = 'social-account-switcher vault v1';

// --- base64 (Uint8Array.toBase64 needs Chrome 140; the minimum is 119) ---

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const random = (length: number): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(length));

// --- password rules ---

/** Every character the same, or a run like 0123456789, abcdefghij or 9876543210. */
function isTooSimple(pw: string): boolean {
  const codes = [...pw.toLowerCase()].map((c) => c.codePointAt(0) ?? 0);
  const steps = new Set(codes.slice(1).map((c, i) => c - (codes[i] ?? 0)));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0] ?? 2);
}

export function validatePassword(pw: string): Result<void, 'too_short' | 'too_simple'> {
  if ([...pw].length < MIN_PASSWORD_LENGTH) return err('too_short');
  if (isTooSimple(pw)) return err('too_simple');
  return ok(undefined);
}

// --- keys ---

async function deriveKey(
  pw: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    true, // extractable only so unlock() can hand the raw key to the keyring
    ['encrypt', 'decrypt'],
  );
}

const exportRaw = async (key: CryptoKey): Promise<string> =>
  toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));

/** The key every other function uses: AES-GCM, not extractable. */
export function importSessionKey(rawKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64(rawKeyB64), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// --- encryption ---

async function encrypt(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  text: string,
): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
}

async function decrypt(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data));
}

/** Base64 of a fresh IV followed by AES-GCM(text). */
export async function seal(key: CryptoKey, text: string): Promise<string> {
  const iv = random(IV_BYTES);
  const body = await encrypt(key, iv, text);
  const out = new Uint8Array(IV_BYTES + body.length);
  out.set(iv);
  out.set(body, IV_BYTES);
  return toBase64(out);
}

/** Reverses seal(). Throws when the key is wrong or the data was changed. */
export function unseal(key: CryptoKey, sealed: string): Promise<string> {
  const bytes = fromBase64(sealed);
  return decrypt(key, bytes.slice(0, IV_BYTES), bytes.slice(IV_BYTES));
}

/** Encrypts a cookie list for the switch journal's `backup` (design 5). */
export const sealCookies = (key: CryptoKey, cookies: StoredCookie[]): Promise<string> =>
  seal(key, JSON.stringify(cookies));

export const openCookies = async (key: CryptoKey, sealed: string): Promise<StoredCookie[]> =>
  JSON.parse(await unseal(key, sealed)) as StoredCookie[];

// --- vault ---

export async function writeVault(key: CryptoKey, vault: Vault, data: SessionMap): Promise<Vault> {
  const iv = random(IV_BYTES);
  const ciphertext = toBase64(await encrypt(key, iv, JSON.stringify(data)));
  return { ...vault, iv: toBase64(iv), ciphertext };
}

/** Throws when the key doesn't match or the vault was changed. */
export async function readVault(key: CryptoKey, vault: Vault): Promise<SessionMap> {
  return JSON.parse(
    await decrypt(key, fromBase64(vault.iv), fromBase64(vault.ciphertext)),
  ) as SessionMap;
}

export async function createVault(
  pw: string,
  data: SessionMap,
): Promise<{ vault: Vault; rawKeyB64: string }> {
  const salt = random(SALT_BYTES);
  const key = await deriveKey(pw, salt);
  const empty: Vault = {
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    iv: '',
    ciphertext: '',
    check: await seal(key, CHECK_TEXT),
  };
  return { vault: await writeVault(key, empty, data), rawKeyB64: await exportRaw(key) };
}

/** True when the vault's KDF settings are ones this version derives with. */
export function isSupportedKdf(kdf: Vault['kdf']): boolean {
  return (
    kdf.name === 'PBKDF2' &&
    kdf.hash === 'SHA-256' &&
    Number.isInteger(kdf.iterations) &&
    kdf.iterations >= PBKDF2_ITERATIONS &&
    kdf.iterations <= MAX_PBKDF2_ITERATIONS &&
    typeof kdf.salt === 'string'
  );
}

/**
 * Derives the key with the salt and iteration count stored in the vault. A vault whose settings are
 * weaker than this version's minimum (or absurdly high) gives `unsupported_vault` without deriving.
 */
export async function unlock(
  pw: string,
  vault: Vault,
): Promise<Result<string, 'wrong_password' | 'unsupported_vault'>> {
  if (!isSupportedKdf(vault.kdf)) return err('unsupported_vault');
  const key = await deriveKey(pw, fromBase64(vault.kdf.salt), vault.kdf.iterations);
  try {
    if ((await unseal(key, vault.check)) !== CHECK_TEXT) return err('wrong_password');
  } catch {
    return err('wrong_password');
  }
  return ok(await exportRaw(key));
}
