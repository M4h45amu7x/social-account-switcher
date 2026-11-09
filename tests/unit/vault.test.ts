// docs/design.md 8.3 test 4.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { StoredCookie } from '../../src/lib/cookies';
import {
  createVault,
  fromBase64,
  importSessionKey,
  openCookies,
  PBKDF2_ITERATIONS,
  readVault,
  type SessionMap,
  sealCookies,
  toBase64,
  unlock,
  type Vault,
  validatePassword,
  writeVault,
} from '../../src/lib/vault';

const PASSWORD = 'orange cat naps by the canal';
const SECRET = 'xs-SECRET-cookie-value-42';
const cookie: StoredCookie = {
  name: 'xs',
  value: SECRET,
  domain: '.facebook.com',
  path: '/',
  hostOnly: false,
  secure: true,
  httpOnly: true,
  sameSite: 'no_restriction',
  expirationDate: 1_900_000_000,
};
const data: SessionMap = { 'acc-1': { capturedAt: 1, cookies: [cookie] } };
const contains = (b64: string, text: string) =>
  Buffer.from(fromBase64(b64)).includes(Buffer.from(text)) || b64.includes(text);

let vault: Vault;
let rawKeyB64: string;
beforeAll(async () => {
  ({ vault, rawKeyB64 } = await createVault(PASSWORD, data));
});

describe('validatePassword', () => {
  test.each([
    ['', 'too_short'],
    ['abc', 'too_short'],
    ['123456789', 'too_short'],
    ['แมวส้มกินข้าว'.slice(0, 9), 'too_short'],
    ['aaaaaaaaaa', 'too_simple'],
    ['AAAAAAAAAAAA', 'too_simple'],
    ['0123456789', 'too_simple'],
    ['abcdefghijkl', 'too_simple'],
    ['ABCDEFGHIJ', 'too_simple'],
    ['9876543210', 'too_simple'],
    ['zyxwvutsrq', 'too_simple'],
  ])('%p is rejected as %p', (pw, error) => {
    expect(validatePassword(pw)).toEqual({ ok: false, error: error as 'too_short' });
  });

  test.each(['orange cat naps', 'แมวส้ม กินข้าว ริมคลอง', '0123456780', 'aaaaaaaaab', 'correct horse'])(
    '%p is accepted',
    (pw) => {
      expect(validatePassword(pw).ok).toBe(true);
    },
  );
});

describe('vault', () => {
  test('uses PBKDF2-SHA-256 with 600,000 iterations and a 16-byte salt', () => {
    expect(vault.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });
    expect(PBKDF2_ITERATIONS).toBe(600000);
    expect(fromBase64(vault.kdf.salt)).toHaveLength(16);
    expect(fromBase64(vault.iv)).toHaveLength(12);
    expect(fromBase64(rawKeyB64)).toHaveLength(32);
  });

  test('encrypt then decrypt gives the same data', async () => {
    const key = await importSessionKey(rawKeyB64);
    expect(await readVault(key, vault)).toEqual(data);
  });

  test('the right password unlocks and returns the same key', async () => {
    expect(await unlock(PASSWORD, vault)).toEqual({ ok: true, value: rawKeyB64 });
  });

  test('a wrong password gives wrong_password', async () => {
    expect(await unlock(`${PASSWORD}!`, vault)).toEqual({ ok: false, error: 'wrong_password' });
  });

  test('a tampered check value gives wrong_password', async () => {
    const key = await importSessionKey(rawKeyB64);
    const otherCheck = (await createVault('another long password', {})).vault.check;
    expect(await unlock(PASSWORD, { ...vault, check: otherCheck })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
    expect(await readVault(key, vault)).toEqual(data);
  });

  test('a check value that decrypts to the wrong text gives wrong_password', async () => {
    // Re-seal the check with the right key but different text.
    const key = await crypto.subtle.importKey('raw', fromBase64(rawKeyB64), 'AES-GCM', false, [
      'encrypt',
    ]);
    const iv = new Uint8Array(12);
    const body = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('nope')),
    );
    const check = toBase64(new Uint8Array([...iv, ...body]));
    expect(await unlock(PASSWORD, { ...vault, check })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
  });

  test('a changed ciphertext fails to decrypt', async () => {
    const key = await importSessionKey(rawKeyB64);
    const bytes = fromBase64(vault.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(readVault(key, { ...vault, ciphertext: toBase64(bytes) })).rejects.toThrow();
  });

  test('the IV is new on every one of 1,000 writes', async () => {
    const key = await importSessionKey(rawKeyB64);
    const ivs = new Set<string>();
    let current = vault;
    for (let i = 0; i < 1000; i += 1) {
      current = await writeVault(key, current, data);
      ivs.add(current.iv);
    }
    expect(ivs.size).toBe(1000);
    expect(ivs.has(vault.iv)).toBe(false);
    expect(await readVault(key, current)).toEqual(data);
  });

  test('neither the ciphertext nor any vault field holds a cookie value in plain text', () => {
    const json = JSON.stringify(vault);
    expect(json).not.toContain(SECRET);
    expect(contains(vault.ciphertext, SECRET)).toBe(false);
    expect(contains(vault.ciphertext, 'facebook')).toBe(false);
  });

  test('importSessionKey returns a non-extractable AES-GCM key', async () => {
    const key = await importSessionKey(rawKeyB64);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  test('two vaults from the same password get different salts and keys', async () => {
    const other = await createVault(PASSWORD, data);
    expect(other.vault.kdf.salt).not.toBe(vault.kdf.salt);
    expect(other.rawKeyB64).not.toBe(rawKeyB64);
  });
});

describe('sealed cookies (journal backup)', () => {
  test('round-trips and holds no plain-text value', async () => {
    const key = await importSessionKey(rawKeyB64);
    const sealed = await sealCookies(key, [cookie]);
    expect(contains(sealed, SECRET)).toBe(false);
    expect(await openCookies(key, sealed)).toEqual([cookie]);
    expect(await sealCookies(key, [cookie])).not.toBe(sealed);
  });
});

test('base64 helpers round-trip every byte value', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect(fromBase64(toBase64(bytes))).toEqual(bytes);
});
