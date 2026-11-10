import { describe, expect, test } from 'bun:test';
import { sanitizeProfile } from '../../src/lib/profile';

// Real 1x1 PNG fixture, no remote asset.
import { PNG } from '../fixtures/profile';

describe('profile trust boundary', () => {
  test('keeps only bounded printable metadata, never remote image URLs or extra fields', () => {
    expect(
      sanitizeProfile({
        displayName: '  Alice\n\u202e Smith ',
        handle: 'a'.repeat(100),
        email: 'a@b.test',
        password: 'secret',
        avatar: 'https://cdn.test/a.png',
      }),
    ).toEqual({ displayName: 'Alice Smith', handle: 'a'.repeat(80), email: 'a@b.test' });
    expect(sanitizeProfile({ displayName: '😀'.repeat(100) })?.displayName).toBe('😀'.repeat(80));
    expect(sanitizeProfile({ displayName: '<img src=x onerror=alert(1)>' })?.displayName).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });
  test('accepts small PNG only with matching magic, dimensions and bounded base64', () => {
    expect(sanitizeProfile({ avatar: PNG })).toEqual({ avatar: PNG });
    for (const avatar of [
      PNG.replace('image/png', 'image/jpeg'),
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png;base64,SGVsbG8=',
      `${PNG}garbage`,
      'data:image/png;base64,' + 'A'.repeat(50000),
    ]) {
      expect(sanitizeProfile({ avatar })).toBeUndefined();
    }
    const bytes = Uint8Array.from(atob(PNG.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
    bytes[19] = 65;
    expect(
      sanitizeProfile({ avatar: `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}` }),
    ).toBeUndefined();
  });
  test('empty, malformed and hostile metadata cannot cross the boundary', () => {
    for (const value of [
      null,
      [],
      false,
      12,
      'name',
      {},
      { displayName: 12 },
      { displayName: '\u0000\u202e' },
    ])
      expect(sanitizeProfile(value)).toBeUndefined();
    expect(sanitizeProfile({ email: 'x'.repeat(1000) })?.email?.length).toBe(254);
  });
});

test('legacy header-only JPEG/WebP data cannot enter the PNG-only store', () => {
  // Header-only representations must never be accepted as complete stored images.
  const encode = (kind: string, bytes: number[]) =>
    `data:image/${kind};base64,${btoa(String.fromCharCode(...bytes))}`;
  const jpeg = [255, 216, 255, 224, 0, 2, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217];
  expect(sanitizeProfile({ avatar: encode('jpeg', jpeg) })).toBeUndefined();
  const large = [...jpeg];
  large[14] = 65;
  expect(sanitizeProfile({ avatar: encode('jpeg', large) })).toBeUndefined();
  const bad = [...jpeg];
  bad[4] = 255;
  expect(sanitizeProfile({ avatar: encode('jpeg', bad) })).toBeUndefined();
  for (const kind of ['VP8X', 'VP8 ', 'VP8L']) {
    const bytes = new Array<number>(30).fill(0);
    for (const [offset, text] of [
      [0, 'RIFF'],
      [8, 'WEBP'],
      [12, kind],
    ] as const)
      for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
    bytes[4] = 22;
    if (kind === 'VP8 ') {
      bytes[23] = 157;
      bytes[24] = 1;
      bytes[25] = 42;
      bytes[26] = 1;
      bytes[28] = 1;
    }
    if (kind === 'VP8L') bytes[20] = 47;
    expect(sanitizeProfile({ avatar: encode('webp', bytes) })).toBeUndefined();
    expect(sanitizeProfile({ avatar: encode('png', bytes) })).toBeUndefined();
    if (kind === 'VP8X') bytes[24] = 64;
    if (kind === 'VP8 ') bytes[26] = 65;
    if (kind === 'VP8L') bytes[21] = 64;
    expect(sanitizeProfile({ avatar: encode('webp', bytes) })).toBeUndefined();
  }
});

// Catches returning the original data URL after checking only IHDR dimensions.
test('stored avatars reject appended HTML, header-only PNG, truncated chunks and bad checksums', () => {
  const raw = atob(PNG.split(',')[1] ?? '');
  const corrupt = raw.slice(0, 45) + String.fromCharCode(raw.charCodeAt(45) ^ 1) + raw.slice(46);
  for (const bytes of [
    raw + '<html><script>avatar_payload()</script></html>',
    raw.slice(0, 33),
    raw.slice(0, -4),
    raw.slice(0, 50),
    corrupt,
  ]) {
    expect(
      sanitizeProfile({ displayName: 'Alice', avatar: `data:image/png;base64,${btoa(bytes)}` }),
    ).toEqual({ displayName: 'Alice' });
  }
});
