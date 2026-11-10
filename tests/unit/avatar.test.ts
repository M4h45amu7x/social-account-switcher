import { afterEach, expect, test } from 'bun:test';
import { canonicalAvatar } from '../../src/background/avatar';
import { readProfile } from '../../src/background/profile';
import { fakeChrome } from '../fakes/chrome';
import { PNG } from '../fixtures/profile';

const names = ['createImageBitmap', 'OffscreenCanvas'] as const;
const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
afterEach(() => {
  names.forEach((name, i) => {
    const descriptor = originals[i];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
});
const raw = (value: string) =>
  Uint8Array.from(atob(value.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
const encode = (kind: string, bytes: number[] | Uint8Array) =>
  `data:image/${kind};base64,${btoa(String.fromCharCode(...bytes))}`;

// Only the browser codec is mocked here. Real decoding is exercised by the Chromium Add tests.
function codec(
  options: {
    width?: number;
    context?: boolean;
    output?: Blob;
    beforeDecode?: () => Promise<void>;
  } = {},
) {
  const seen: Blob[] = [];
  let closed = 0;
  Object.assign(globalThis, {
    createImageBitmap: async (blob: Blob) => {
      seen.push(blob);
      await options.beforeDecode?.();
      return {
        width: options.width ?? 1,
        height: 1,
        close: () => {
          closed++;
        },
      };
    },
    OffscreenCanvas: class {
      getContext() {
        return options.context === false ? null : { drawImage() {} };
      }
      async convertToBlob() {
        return options.output ?? new Blob([raw(PNG)]);
      }
    },
  });
  return { seen, closed: () => closed };
}

test('source bytes are never returned; only locally encoded pixels survive, and bitmaps close', async () => {
  const c = codec();
  const source = encode('png', [
    ...raw(PNG),
    ...new TextEncoder().encode('<html>avatar_payload</html>'),
  ]);
  expect(await canonicalAvatar(source)).toBe(PNG);
  expect(c.seen[0]?.type).toBe('image/png');
  expect(c.closed()).toBe(1);
});

test('invalid formats, large inputs and spoofed dimensions are rejected before decoding', async () => {
  const c = codec();
  const oversized = raw(PNG);
  oversized[19] = 65;
  for (const source of [
    null,
    '',
    'https://cdn.test/a.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    `data:image/png;base64,${'A'.repeat(50000)}`,
    'data:image/png;base64,A',
    encode('png', new Uint8Array(32769)),
    encode('png', oversized),
    encode('jpeg', raw(PNG)),
  ])
    expect(await canonicalAvatar(source)).toBeUndefined();
  expect(c.seen).toEqual([]);
});

test('JPEG/WebP headers bound decoder allocation but cannot substitute for successful decoding', async () => {
  const c = codec({
    beforeDecode: async () => {
      throw new Error('incomplete image');
    },
  });
  const jpeg = [255, 216, 255, 224, 0, 2, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217];
  expect(await canonicalAvatar(encode('jpeg', jpeg))).toBeUndefined();
  const large = [...jpeg];
  large[14] = 65;
  const bad = [...jpeg];
  bad[4] = 255;
  for (const input of [large, bad])
    expect(await canonicalAvatar(encode('jpeg', input))).toBeUndefined();
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
    expect(await canonicalAvatar(encode('webp', bytes))).toBeUndefined();
    if (kind === 'VP8X') bytes[24] = 64;
    if (kind === 'VP8 ') bytes[26] = 65;
    if (kind === 'VP8L') bytes[21] = 64;
    expect(await canonicalAvatar(encode('webp', bytes))).toBeUndefined();
  }
  expect(c.seen).toHaveLength(4);
});

test('decode/encode failures, oversized decoded pixels/output and noncanonical output fall back safely', async () => {
  for (const options of [
    { width: 65 },
    { width: 0 },
    { context: false },
    { output: new Blob([new Uint8Array(32769)]) },
    { output: new Blob(['not a PNG']) },
  ]) {
    const c = codec(options);
    expect(await canonicalAvatar(PNG)).toBeUndefined();
    expect(c.closed()).toBe(1);
  }
});

test('profile capture retains text on decode failure and confirms identity after encoding', async () => {
  const c = fakeChrome({ tabs: [{ url: 'https://www.facebook.com/', active: true }] });
  const tab = (await c.tabs.query({ active: true }))[0]?.id as number;
  c.scripting.pageResults.set(tab, {
    identity: '1001',
    profile: { displayName: 'Alice', avatar: PNG },
  });
  codec({
    beforeDecode: async () => {
      throw new Error('bad pixels');
    },
  });
  expect(
    await readProfile({ ...c, currentIdentity: async () => '1001' }, 'facebook', '1001', tab),
  ).toEqual({ displayName: 'Alice' });
  let identity = '1001';
  codec({
    beforeDecode: async () => {
      identity = '2002';
    },
  });
  expect(
    await readProfile({ ...c, currentIdentity: async () => identity }, 'facebook', '1001', tab),
  ).toBeUndefined();
  codec();
  expect(
    await readProfile({ ...c, currentIdentity: async () => '1001' }, 'facebook', '1001', tab),
  ).toEqual({ displayName: 'Alice', avatar: PNG });
});

test('late decoding cannot bypass the metadata deadline and still closes its bitmap', async () => {
  const c = fakeChrome({ tabs: [{ url: 'https://www.facebook.com/', active: true }] });
  const tab = (await c.tabs.query({ active: true }))[0]?.id as number;
  c.scripting.pageResults.set(tab, {
    identity: '1001',
    profile: { displayName: 'Alice', avatar: PNG },
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decoder = codec({ beforeDecode: () => held });
  expect(
    await readProfile(
      { ...c, timeoutMs: 5, currentIdentity: async () => '1001' },
      'facebook',
      '1001',
      tab,
    ),
  ).toBeUndefined();
  release();
  for (let i = 0; i < 20 && !decoder.closed(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(decoder.closed()).toBe(1);
});
