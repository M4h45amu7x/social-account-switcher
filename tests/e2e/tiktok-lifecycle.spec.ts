import { expect, test } from '@playwright/test';
import type { StoreV1 } from '../../src/lib/store';
import { idle } from './popup-build';
import { buildTikTok } from './tiktok-build';
import {
  add,
  cookies,
  launchTikTok,
  PASSWORD,
  saved,
  send,
  setupPair,
  type TestHooks,
  tokenOf,
  worker,
} from './tiktok-helpers';

test.beforeAll(buildTikTok);

test('TikTok: actual worker termination leaves journal; startup recovers authenticated rotating backup', async () => {
  test.setTimeout(60_000);
  const h = await launchTikTok();
  try {
    const { alice } = await setupPair(h);
    const cdp = await h.context.newCDPSession(h.popup);
    const versions = new Map<string, string>();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const v of event.versions as {
        versionId: string;
        scriptURL: string;
        runningStatus: string;
      }[])
        if (v.scriptURL.includes(h.extensionId)) versions.set(v.versionId, v.runningStatus);
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versions.size).toBeGreaterThan(0);
    await h.sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.hold());
    // Attach rejection immediately: termination intentionally closes the pending message channel.
    const pending = send(h.popup, { type: 'account.switch', accountId: alice }).catch(() => null);
    await expect
      .poll(() => h.sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.held))
      .toBe(true);
    expect(await h.sw.evaluate(() => chrome.storage.session.get('journal.tiktok'))).toHaveProperty([
      'journal.tiktok',
    ]);
    for (const versionId of versions.keys())
      await cdp.send('ServiceWorker.stopWorker', { versionId });
    await expect.poll(() => [...versions.values()].every((v) => v === 'stopped')).toBe(true);
    await pending;
    // Wake the real service worker listener; the new router waits for recovery before replying.
    await h.tab.bringToFront();
    expect(await send(h.popup, { type: 'state.get' })).toMatchObject({
      ok: true,
      value: { locked: false, busy: [] },
    });
    const restarted = await worker(h.context);
    expect(
      await restarted.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.ready),
    ).toEqual({ rolledBack: ['tiktok'], waiting: [], dropped: [] });
    expect(await restarted.evaluate(() => chrome.storage.session.get('journal.tiktok'))).toEqual(
      {},
    );
    await expect(h.tab.locator('#who')).toHaveAttribute('data-user', 'bob');
    expect(h.fake.valid(tokenOf(await cookies(restarted)), 'bob')).toBe(true);
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toMatchObject({
      ok: true,
    });
    await cdp.detach();
  } finally {
    await h.close();
  }
});

test('TikTok: strict mode rejects stale generations, successful switch stores its newly accepted generation', async () => {
  const h = await launchTikTok();
  try {
    h.fake.strict = true;
    const { alice, bob } = await setupPair(h);
    const stale = tokenOf((await saved(h.sw))[alice]?.cookies ?? []);
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toMatchObject({
      ok: true,
    });
    const fresh = tokenOf((await saved(h.sw))[alice]?.cookies ?? []);
    expect(fresh).not.toBe(stale);
    expect(h.fake.valid(stale, 'alice')).toBe(false);
    expect(h.fake.valid(fresh, 'alice')).toBe(true);
    // Restore the retired generation through the browser cookie store and load a real document.
    await h.sw.evaluate(async (value) => {
      await chrome.cookies.set({
        url: 'https://www.tiktok.com/',
        domain: '.tiktok.com',
        path: '/',
        name: 'sessionid',
        value,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      });
    }, stale);
    await h.tab.reload();
    await expect(h.tab.locator('#who')).toHaveAttribute('data-user', '');
    expect(h.fake.rejected).toContain(stale);
    // Explicit logged-out source can safely switch to another still-valid saved account.
    expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toMatchObject({
      ok: true,
    });
  } finally {
    await h.close();
  }
});

test('TikTok: v0.1.0 encrypted sessions migrate; both wipe scopes remove TikTok; English/Thai popup includes four platforms', async () => {
  test.setTimeout(60_000);
  for (const language of ['en', 'th']) {
    const h = await launchTikTok(language);
    try {
      expect(await send(h.popup, { type: 'vault.setup', password: PASSWORD })).toEqual({
        ok: true,
      });
      await h.sw.evaluate(async () => {
        for (const [name, value] of [
          ['c_user', 'old-user'],
          ['xs', 'old-secret'],
        ])
          await chrome.cookies.set({
            url: 'https://www.facebook.com/',
            domain: '.facebook.com',
            path: '/',
            name: name as string,
            value: value as string,
            secure: true,
          });
      });
      const old = await send(h.popup, {
        type: 'account.addCurrent',
        platform: 'facebook',
        label: 'Old Alice',
      });
      expect(old.ok).toBe(true);
      const oldId = (old.value as { id: string }).id;
      const oldSession = (await saved(h.sw))[oldId];
      // This is the v0.1.0 store shape: schema 1, no TikTok active slot, real encrypted old session.
      await h.sw.evaluate(async () => {
        const store = (await chrome.storage.local.get('store')).store as StoreV1;
        delete (store.active as Partial<StoreV1['active']>).tiktok;
        store.settings.language = 'th';
        store.accounts.push({
          id: 'old-youtube',
          platform: 'youtube',
          label: 'Old channel',
          initials: 'OC',
          youtube: { authuser: 0 },
          status: 'ok',
          createdAt: 1,
          lastUsedAt: null,
          sessionCapturedAt: null,
        });
        await chrome.storage.local.set({ store });
      });
      expect(await send(h.popup, { type: 'state.get' })).toMatchObject({
        ok: true,
        value: { active: { tiktok: null }, quarantined: 0 },
      });
      const id = await add(h, 'alice');
      expect((await saved(h.sw))[oldId]).toEqual(oldSession);
      expect((await saved(h.sw))[id]?.cookies.length).toBeGreaterThan(0);
      expect(await send(h.popup, { type: 'settings.set', language })).toEqual({ ok: true });
      await h.popup.setViewportSize({ width: 360, height: 600 });
      await h.popup.reload();
      await expect(h.popup.getByTestId('popup')).toHaveAttribute('data-state', 'list');
      await expect(h.popup.getByTestId('tab-tiktok')).toHaveAttribute('aria-selected', 'true');
      await expect(h.popup.getByTestId(`row-${id}`)).toBeVisible();
      await h.popup.getByTestId('tab-facebook').click();
      await expect(h.popup.getByTestId(`row-${oldId}`)).toBeVisible();
      await h.popup.getByTestId('tab-tiktok').click();
      await expect(h.popup.getByTestId(`row-${id}`)).toBeVisible();
      await expect(h.popup.locator('.spinner')).toHaveCount(0);
      await expect(h.popup.getByRole('tab')).toHaveCount(4);
      await expect(h.popup.locator('html')).toHaveAttribute('lang', language);
      await idle(h.popup);
      await h.popup.screenshot({
        path: test.info().outputPath(`popup-${language}.png`),
        animations: 'disabled',
      });
      await expect(h.popup.getByTestId('tab-tiktok')).toHaveAttribute('aria-label', 'TikTok');
      expect(
        await h.popup.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // Wipe session scope preserves non-session shortcuts/settings and leaves website cookies alone.
      h.fake.revoke('alice');
      await h.tab.bringToFront();
      expect(await send(h.popup, { type: 'account.switch', accountId: id })).toEqual({
        ok: false,
        error: 'rollback_failed',
      });
      expect(
        await h.sw.evaluate(() => chrome.storage.session.get('journal.tiktok')),
      ).toHaveProperty(['journal.tiktok']);
      const browserBefore = await cookies(h.sw);
      expect(await send(h.popup, { type: 'vault.wipe', scope: 'sessions' })).toEqual({ ok: true });
      expect(await send(h.popup, { type: 'state.get' })).toMatchObject({
        value: {
          accounts: [expect.objectContaining({ id: 'old-youtube' })],
          hasVault: false,
          locked: true,
          active: { tiktok: null },
          settings: { language },
        },
      });
      expect(await cookies(h.sw)).toEqual(browserBefore);
      expect(await h.sw.evaluate(() => chrome.storage.session.get(null))).toEqual({});
      await send(h.popup, { type: 'vault.setup', password: PASSWORD });
      const bob = await add(h, 'bob');
      h.fake.revoke('bob');
      expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toEqual({
        ok: false,
        error: 'rollback_failed',
      });
      expect(
        await h.sw.evaluate(() => chrome.storage.session.get('journal.tiktok')),
      ).toHaveProperty(['journal.tiktok']);
      expect(await send(h.popup, { type: 'vault.wipe', scope: 'all' })).toEqual({ ok: true });
      expect(await h.sw.evaluate(() => chrome.storage.local.get('store'))).toEqual({});
      expect(await h.sw.evaluate(() => chrome.storage.session.get(null))).toEqual({});
    } finally {
      await h.close();
    }
  }
});

test('TikTok: production worker enables TikTok without fixture hooks and refuses an unrelated tab', async () => {
  const { launchExtension } = await import('./fixtures');
  const launched = await launchExtension();
  try {
    const sw = await worker(launched.context);
    expect(await sw.evaluate(() => '__tiktokTest' in globalThis)).toBe(false);
    const extensionId = new URL(sw.url()).host;
    const page = await launched.context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    const before = await cookies(sw);
    expect(await send(page, { type: 'account.probe', platform: 'tiktok', tabId: 1 })).toEqual({
      ok: false,
      error: 'no_tiktok_tab',
    });
    expect(
      await send(page, {
        type: 'account.addCurrent',
        platform: 'tiktok',
        label: 'Unrelated tab',
        tabId: 1,
      }),
    ).toEqual({ ok: false, error: 'no_tiktok_tab' });
    expect(await cookies(sw)).toEqual(before);
    expect(await send(page, { type: 'vault.setup', password: PASSWORD })).toEqual({ ok: true });
    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.getByTestId('tab-tiktok')).toHaveAttribute('aria-label', 'TikTok');
  } finally {
    await launched.close();
  }
});
