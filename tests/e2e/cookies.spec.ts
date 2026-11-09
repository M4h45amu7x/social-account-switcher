// Card B2: checks in real Chromium what src/lib/cookies.ts assumes about chrome.cookies
// (docs/design.md 3.4), then runs snapshot / clear / restore from that file against it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures';

const SECRET = 'xs-e2e-secret-value';
let bundle = '';

test.beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'sas-probe-'));
  const file = join(out, 'cookies.js');
  execFileSync(
    'bun',
    [
      'build',
      resolve(import.meta.dirname, 'probe/cookies-entry.ts'),
      '--format=iife',
      `--outfile=${file}`,
    ],
    { stdio: 'pipe' },
  );
  bundle = readFileSync(file, 'utf8');
  rmSync(out, { recursive: true, force: true });
});

async function worker(context: import('@playwright/test').BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/** A signed-in looking Facebook: domain, host-only, partitioned, device and session cookies. */
async function seed(sw: Worker) {
  await sw.evaluate(async (secret) => {
    const url = 'https://www.facebook.com/';
    const year = Date.now() / 1000 + 365 * 86400;
    const base = { url, path: '/', secure: true, httpOnly: false, sameSite: 'lax' as const };
    await chrome.cookies.set({
      ...base,
      name: 'c_user',
      value: '1001',
      domain: 'facebook.com',
      expirationDate: year,
    });
    await chrome.cookies.set({
      ...base,
      name: 'xs',
      value: secret,
      domain: 'facebook.com',
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: year,
    });
    await chrome.cookies.set({ ...base, name: 'presence', value: 'p', domain: 'facebook.com' });
    await chrome.cookies.set({ ...base, name: 'host_only', value: 'h', sameSite: 'strict' });
    await chrome.cookies.set({
      ...base,
      name: 'chips',
      value: 'c',
      sameSite: 'no_restriction',
      partitionKey: { topLevelSite: 'https://instagram.com' },
    });
    await chrome.cookies.set({
      ...base,
      name: 'datr',
      value: 'device',
      domain: 'facebook.com',
      expirationDate: year,
    });
    await chrome.cookies.set({
      ...base,
      url: 'https://www.instagram.com/',
      name: 'sessionid',
      value: 'ig',
      domain: 'instagram.com',
    });
  }, SECRET);
}

const names = (list: { name: string }[]) => list.map((c) => c.name).sort();

test('getAll with partitionKey {} returns unpartitioned and partitioned cookies together', async ({
  context,
}) => {
  const sw = await worker(context);
  await seed(sw);
  const got = await sw.evaluate(async () => ({
    none: await chrome.cookies.getAll({ domain: 'facebook.com' }),
    all: await chrome.cookies.getAll({ domain: 'facebook.com', partitionKey: {} }),
    site: await chrome.cookies.getAll({
      domain: 'facebook.com',
      partitionKey: { topLevelSite: 'https://instagram.com' },
    }),
  }));
  expect(names(got.none)).toEqual(['c_user', 'datr', 'host_only', 'presence', 'xs']);
  expect(names(got.all)).toEqual(['c_user', 'chips', 'datr', 'host_only', 'presence', 'xs']);
  expect(names(got.site)).toEqual(['chips']);
  expect(got.all.find((c) => c.name === 'chips')?.partitionKey?.topLevelSite).toBe(
    'https://instagram.com',
  );
});

test('remove without partitionKey resolves but leaves a partitioned cookie in place', async ({
  context,
}) => {
  const sw = await worker(context);
  await seed(sw);
  const left = await sw.evaluate(async () => {
    const removed = await chrome.cookies.remove({
      url: 'https://www.facebook.com/',
      name: 'chips',
    });
    const after = await chrome.cookies.getAll({
      domain: 'facebook.com',
      name: 'chips',
      partitionKey: {},
    });
    return { removed: removed !== null, after: after.length };
  });
  expect(left).toEqual({ removed: true, after: 1 });
});

test('snapshot, clear and restore from src/lib/cookies.ts round-trip in Chromium', async ({
  context,
}) => {
  const sw = await worker(context);
  const consoleLines: string[] = [];
  sw.on('console', (m) => consoleLines.push(m.text()));
  await sw.evaluate(bundle);
  await seed(sw);
  const result = await sw.evaluate(async () => {
    const lib = (globalThis as unknown as { __samCookies: typeof import('../../src/lib/cookies') })
      .__samCookies;
    const facebook = {
      id: 'facebook' as const,
      label: 'Facebook',
      cookieDomain: 'facebook.com',
      tabPatterns: [],
      idCookie: 'c_user',
      deviceCookies: new Set(['datr', 'sb', 'locale', 'wd', 'dpr']),
      loginUrl: '',
      isCheckpointUrl: () => false,
    };
    const api = chrome.cookies as unknown as Parameters<typeof lib.snapshot>[0];
    const saved = await lib.snapshot(api, facebook);
    const user = await lib.currentUserId(api, facebook);
    const removed = await lib.clear(api, facebook);
    const afterClear = await chrome.cookies.getAll({ domain: 'facebook.com', partitionKey: {} });
    const userAfterClear = await lib.currentUserId(api, facebook);
    const restored = await lib.restore(api, saved, Date.now());
    const again = await lib.snapshot(api, facebook);
    const ig = await chrome.cookies.getAll({ domain: 'instagram.com' });
    return { saved, user, removed, afterClear, userAfterClear, restored, again, ig };
  });
  expect(names(result.saved)).toEqual(['c_user', 'chips', 'host_only', 'presence', 'xs']);
  expect(result.user).toBe('1001');
  expect(result.removed).toBe(5);
  expect(names(result.afterClear)).toEqual(['datr']); // the device cookie stays
  expect(result.userAfterClear).toBeNull();
  expect(result.restored).toEqual({ ok: true, value: 5 });
  // Same cookies back: host-only stays host-only, the partition and SameSite survive.
  const sort = <T extends { name: string }>(l: T[]) =>
    [...l].sort((a, b) => a.name.localeCompare(b.name));
  expect(sort(result.again)).toEqual(sort(result.saved));
  expect(result.again.find((c) => c.name === 'host_only')).toMatchObject({
    hostOnly: true,
    domain: 'www.facebook.com',
    sameSite: 'strict',
  });
  expect(result.again.find((c) => c.name === 'chips')?.partitionKey?.topLevelSite).toBe(
    'https://instagram.com',
  );
  expect(names(result.ig)).toEqual(['sessionid']); // another platform is untouched
  expect(consoleLines.filter((l) => l.includes(SECRET))).toEqual([]);
});
