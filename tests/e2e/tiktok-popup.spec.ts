// Production dist/ popup and service worker, local HTTPS pages, fictional identities only.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page, test, type Worker } from '@playwright/test';
import { addAccount, type StoreV1 } from '../../src/lib/store';
import { fakeTikTok, fixtureUid, TT, TT_OTHER } from './fake-tiktok';
import { launchExtension } from './fixtures';
import { startHttpsSites } from './https-sites';

const PASSWORD = 'orange cat naps by the canal';
const dist = process.env.TIKTOK_POPUP_DIST ?? resolve(import.meta.dirname, '../../dist');
const screen = (page: Page) => page.getByTestId('popup');
const store = (sw: Worker) =>
  sw.evaluate(async () => (await chrome.storage.local.get('store')).store as StoreV1);

async function launch(dir = dist) {
  readFileSync(join(dir, 'manifest.json'), 'utf8');
  const fake = fakeTikTok();
  const sites = await startHttpsSites([TT, TT_OTHER], fake.handler);
  const launched = await launchExtension({ dir, locale: 'en', extraArgs: sites.args }).catch(
    async (error) => {
      await sites.close();
      throw error;
    },
  );
  try {
    const context = launched.context;
    const sw =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    expect(await sw.evaluate(() => '__tiktokTest' in globalThis)).toBe(false);
    const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup/index.html`;
    const forbiddenRequests: string[] = [];
    context.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('chrome-extension:') || url.startsWith('data:')) return;
      if (![TT, TT_OTHER].some((host) => url.startsWith(`https://${host}/`))) {
        forbiddenRequests.push(url);
        return;
      }
      if (
        request.serviceWorker() ||
        (!request.isNavigationRequest() && request.frame().url().startsWith('chrome-extension:'))
      )
        forbiddenRequests.push(`extension initiated: ${url}`);
    });
    await context.addInitScript(() => {
      const visible: string[] = [];
      Object.assign(globalThis, { __visiblePlatforms: visible });
      const tick = () => {
        const root = document.querySelector<HTMLElement>('[data-testid="popup"]');
        if (root && document.querySelector('[role="tab"]') && root.dataset.state !== 'loading')
          visible.push(root.dataset.platform ?? 'missing');
        if (visible.length < 120) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return {
      fake,
      context,
      sw,
      popupUrl,
      close: async () => {
        try {
          await launched.close();
        } finally {
          await sites.close();
        }
        expect(forbiddenRequests, 'only ordinary page requests reach local fixtures').toEqual([]);
      },
    };
  } catch (error) {
    await launched.close();
    await sites.close();
    throw error;
  }
}
type Harness = Awaited<ReturnType<typeof launch>>;

async function setup(h: Harness) {
  const page = await h.context.newPage();
  await page.goto(h.popupUrl);
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('setup-create').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  await page.close();
}
async function newTab(h: Harness, url: string, separateWindow = false) {
  if (separateWindow) {
    const created = h.context.waitForEvent('page');
    const window = await h.sw.evaluate((url) => chrome.windows.create({ url, focused: true }), url);
    const page = await created;
    await page.waitForLoadState();
    const id = window?.tabs?.[0]?.id;
    if (id === undefined) throw new Error('Fixture window has no tab');
    return { page, id };
  }
  const page = await h.context.newPage();
  await page.goto(url);
  // Host denial withholds the URL but still exposes tab IDs.
  await page.bringToFront();
  const tab = await h.sw.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
  );
  if (tab?.id === undefined) throw new Error('Fixture tab is missing');
  return { page, id: tab.id };
}
async function popupOver(h: Harness, tabId: number) {
  const opened = h.context.waitForEvent('page');
  await h.sw.evaluate(
    async ({ tabId, popupUrl }) => {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.tabs.create({ windowId: tab.windowId, url: popupUrl, active: false });
    },
    { tabId, popupUrl: h.popupUrl },
  );
  const popup = await opened;
  await expect(screen(popup)).toHaveAttribute('data-state', /empty|list/);
  return popup;
}
async function uiAdd(h: Harness, popup: Page, user: string, label = user) {
  await popup.getByTestId('add-account').click();
  await popup.getByTestId('add-input').fill(label);
  await popup.getByTestId('add-save').click();
  await expect(screen(popup)).toHaveAttribute('data-state', 'list');
  const account = (await store(h.sw)).accounts.find((a) => a.label === label);
  expect(account).toMatchObject({ platform: 'tiktok', platformUserId: fixtureUid(user) });
  if (!account) throw new Error('UI did not save the account');
  await expect(popup.getByTestId(`row-${account.id}`).getByTestId('chip-here')).toHaveText(
    'On this tab',
  );
  return account.id;
}
const row = (popup: Page, id: string) => popup.getByTestId(`row-${id}`);

test('production TikTok popup: first visible frame, UI adds two accounts and five switches update the current badge', async () => {
  test.setTimeout(120_000);
  const h = await launch();
  try {
    await setup(h);
    const tab = await newTab(h, `https://${TT}/__e2e/login?user=alice`);
    let popup = await popupOver(h, tab.id);
    await expect(popup.getByTestId('tab-tiktok')).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() =>
        popup.evaluate(
          () => (globalThis as unknown as { __visiblePlatforms: string[] }).__visiblePlatforms[0],
        ),
      )
      .toBe('tiktok');
    expect(await popup.getByRole('tab').count()).toBe(4);
    const alice = await uiAdd(h, popup, 'alice', 'Alice saved');
    await popup.close();
    await tab.page.goto(`https://${TT}/__e2e/login?user=bob`);
    popup = await popupOver(h, tab.id);
    const bob = await uiAdd(h, popup, 'bob', 'Bob saved');
    for (const [id, user] of [
      [alice, 'alice'],
      [bob, 'bob'],
      [alice, 'alice'],
      [bob, 'bob'],
      [alice, 'alice'],
    ] as const) {
      await row(popup, id).locator('[data-act="switch"]').click();
      await expect(tab.page.locator('#who')).toHaveAttribute('data-user', user);
      await expect(row(popup, id).getByTestId('chip-here')).toHaveText('On this tab');
      await expect(popup.getByTestId('chip-here')).toHaveCount(1);
      expect((await store(h.sw)).active.tiktok).toBe(id);
    }
    await popup.getByTestId(`rename-${alice}`).click();
    await popup.getByTestId('rename-input').fill('Alice renamed');
    await popup.getByTestId('rename-save').click();
    await expect(row(popup, alice)).toContainText('Alice renamed');
    await popup.getByTestId(`delete-${bob}`).click();
    await popup.getByTestId('delete-confirm').click();
    await expect(row(popup, bob)).toHaveCount(0);
    expect((await store(h.sw)).accounts.map((a) => a.platformUserId)).toEqual([
      fixtureUid('alice'),
    ]);
  } finally {
    await h.close();
  }
});

test('production TikTok popup: window A without TikTok cannot borrow window B for probe or add', async () => {
  const h = await launch();
  try {
    await setup(h);
    const a = await newTab(h, `https://${TT_OTHER}/window-a`);
    await newTab(h, `https://${TT}/__e2e/login?user=bob`, true);
    const popup = await popupOver(h, a.id);
    await popup.getByTestId('tab-tiktok').click();
    const before = await h.sw.evaluate(() => chrome.storage.local.get(null));
    const cookies = await h.context.cookies();
    await popup.getByTestId('add-account').click();
    await expect(popup.getByTestId('notice')).toHaveAttribute('data-code', 'no_tiktok_tab');
    await expect(popup.getByTestId('add-input')).toHaveCount(0);
    expect(await h.sw.evaluate(() => chrome.storage.local.get(null))).toEqual(before);
    expect(await h.context.cookies()).toEqual(cookies);
    expect((await store(h.sw)).accounts).toEqual([]);
  } finally {
    await h.close();
  }
});

test('production TikTok popup: probe and add use window A identity while window B displays a challenge', async () => {
  const h = await launch();
  try {
    await setup(h);
    const a = await newTab(h, `https://${TT}/__e2e/login?user=alice`);
    h.fake.modes.set('bob', 'checkpoint');
    const b = await newTab(h, `https://${TT}/__e2e/login?user=bob`, true);
    await expect(b.page.locator('#verifyEle')).toHaveCount(1);
    await a.page.goto(`https://${TT}/__e2e/login?user=alice`);
    await expect(a.page.locator('#who')).toHaveAttribute('data-user', 'alice');
    const popup = await popupOver(h, a.id);
    await expect(screen(popup)).toHaveAttribute('data-platform', 'tiktok');
    const id = await uiAdd(h, popup, 'alice', 'Window A saved');
    await popup.reload();
    await expect(row(popup, id).getByTestId('chip-here')).toHaveText('On this tab');
    await expect(popup.getByTestId('notice')).toHaveCount(0);
    await expect(b.page.locator('#verifyEle')).toHaveCount(1);
    expect((await store(h.sw)).accounts).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test('production TikTok popup: actual missing host permission shows access guidance and preserves data', async () => {
  const denied = mkdtempSync(join(tmpdir(), 'sam-t659-denied-'));
  let h: Harness | undefined;
  try {
    cpSync(dist, denied, { recursive: true });
    const manifestPath = join(denied, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      host_permissions: string[];
    };
    manifest.host_permissions = manifest.host_permissions.filter(
      (host) => !host.includes('tiktok'),
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));
    h = await launch(denied);
    await setup(h);
    const tab = await newTab(h, `https://${TT}/__e2e/login?user=alice`);
    expect(
      await h.sw.evaluate(() =>
        chrome.permissions.contains({ origins: ['https://*.tiktok.com/*'] }),
      ),
    ).toBe(false);
    const popup = await popupOver(h, tab.id);
    await popup.getByTestId('tab-tiktok').click();
    const before = await h.sw.evaluate(() => chrome.storage.local.get(null));
    const cookies = await h.context.cookies();
    await popup.getByTestId('add-account').click();
    await expect(popup.getByTestId('notice')).toHaveAttribute('data-code', 'tiktok_permission');
    await expect(popup.getByTestId('notice')).toContainText(/TikTok/);
    await expect(popup.getByTestId('notice')).toContainText(/access|permission/i);
    await expect(popup.getByTestId('notice')).not.toContainText(/expired/i);
    expect(await h.sw.evaluate(() => chrome.storage.local.get(null))).toEqual(before);
    expect(await h.context.cookies()).toEqual(cookies);
    expect(await h.sw.evaluate(() => chrome.storage.session.get('journal.tiktok'))).toEqual({});
  } finally {
    try {
      await h?.close();
    } finally {
      rmSync(denied, { recursive: true, force: true });
    }
  }
});

for (const scope of ['sessions', 'all'] as const) {
  test(`production TikTok popup: ${scope} wipe clears saved TikTok data and recovery state`, async () => {
    const h = await launch();
    try {
      await setup(h);
      const tab = await newTab(h, `https://${TT}/__e2e/login?user=alice`);
      const popup = await popupOver(h, tab.id);
      await uiAdd(h, popup, 'alice');
      const added = addAccount(
        await store(h.sw),
        { platform: 'youtube', label: 'Keep YouTube shortcut', youtube: { authuser: 0 } },
        { id: 'youtube-control', now: Date.now() },
      );
      if (!added.ok) throw new Error(added.error);
      await h.sw.evaluate(async (value) => {
        await chrome.storage.local.set({ store: value });
        await chrome.storage.session.set({ 'journal.tiktok': { test: 'wipe-control' } });
      }, added.value.store);
      const siteCookies = await h.context.cookies();
      await popup.getByTestId('settings-btn').click();
      if (scope === 'all') {
        await popup.getByTestId('s-wipe').click();
        await popup.getByTestId('s-wipe-ok').click();
      } else {
        await popup.getByTestId('lock-now').click();
        await popup.getByTestId('forgot').click();
        await popup.getByTestId('wipe-ok').click();
      }
      await expect(screen(popup)).toHaveAttribute('data-state', 'setup');
      if (scope === 'all') {
        expect(await h.sw.evaluate(() => chrome.storage.local.get(null))).toEqual({});
      } else {
        const after = await store(h.sw);
        expect(after.accounts.map((a) => a.id)).toEqual(['youtube-control']);
        expect(after.active.tiktok).toBeNull();
        expect(after.vault).toBeNull();
      }
      const state = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'state.get' }));
      expect(state).toMatchObject({
        ok: true,
        value: { hasVault: false, active: { tiktok: null } },
      });
      expect(state.value.accounts.map((account: { id: string }) => account.id)).toEqual(
        scope === 'sessions' ? ['youtube-control'] : [],
      );
      const session = await h.sw.evaluate(() => chrome.storage.session.get(null));
      expect(Object.keys(session).some((key) => /tiktok|key|unlockFailures/i.test(key))).toBe(
        false,
      );
      expect(await h.context.cookies()).toEqual(siteCookies);
    } finally {
      await h.close();
    }
  });
}
