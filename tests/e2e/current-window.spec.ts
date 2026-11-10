import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addAccount, type StoreV1 } from '../../src/lib/store';
import { expect, launchExtension, test } from './fixtures';
import { startHttpsSites } from './https-sites';

test('two windows: badge and add follow the YouTube tab of the popup window', async () => {
  test.setTimeout(60_000);
  const sites = await startHttpsSites(['www.youtube.com'], (_req, res, url) => {
    const authuser = url.searchParams.get('authuser') ?? '0';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Window ${authuser}</title>
      <script>var ytcfg={get:k=>k==='SESSION_INDEX'?${JSON.stringify(authuser)}:undefined}</script>`);
  });
  let close: (() => Promise<void>) | undefined;
  try {
    const launched = await launchExtension({ extraArgs: sites.args });
    close = launched.close;
    const context = launched.context;
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup/index.html`;
    const setup = await context.newPage();
    await setup.goto(popupUrl);
    await setup.getByTestId('pw-input').fill('orange cat naps by the canal');
    await setup.getByTestId('setup-create').click();
    await expect(setup.getByTestId('popup')).toHaveAttribute('data-state', 'empty');
    await setup.close();

    const a = await context.newPage();
    await a.goto('https://www.youtube.com/?authuser=0');
    const tabA = await sw.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/?authuser=0' }))[0],
    );
    expect(tabA?.id).toBeDefined();
    const newPage = context.waitForEvent('page');
    const windowB = await sw.evaluate(() =>
      chrome.windows.create({ url: 'https://www.youtube.com/?authuser=2', focused: true }),
    );
    const b = await newPage;
    await b.waitForLoadState();
    const tabB = windowB?.tabs?.[0];
    expect(tabB?.windowId).not.toBe(tabA?.windowId);
    const active = await sw.evaluate(() =>
      chrome.tabs.query({ active: true, url: '*://*.youtube.com/*' }),
    );
    expect(active.map((t) => t.id)).toEqual(expect.arrayContaining([tabA?.id, tabB?.id]));
    expect(active[0]?.id).toBe(tabA?.id);

    let store = await sw.evaluate(
      async () => (await chrome.storage.local.get('store')).store as StoreV1,
    );
    for (const [id, label, authuser] of [
      ['window-a', 'Window A', 0],
      ['window-b', 'Window B', 2],
    ] as const) {
      const added = addAccount(
        store,
        { platform: 'youtube', label, youtube: { authuser } },
        { id, now: Date.now() },
      );
      if (!added.ok) throw new Error(added.error);
      store = added.value.store;
    }
    await sw.evaluate((value) => chrome.storage.local.set({ store: value }), store);

    const popupOver = async (siteTab: number) => {
      const opened = context.waitForEvent('page');
      await sw.evaluate(
        async ({ siteTab, popupUrl }) => {
          const tab = await chrome.tabs.get(siteTab);
          await chrome.tabs.update(siteTab, { active: true });
          await chrome.tabs.create({ windowId: tab.windowId, url: popupUrl, active: false });
        },
        { siteTab, popupUrl },
      );
      const page = await opened;
      await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'list');
      await expect(page.getByTestId('popup')).toHaveAttribute('data-platform', 'youtube');
      return page;
    };
    const pageB = await popupOver(tabB?.id as number);
    await expect(pageB.getByTestId('row-window-b').getByTestId('chip-here')).toHaveText(
      'On this tab',
    );
    await expect(pageB.getByTestId('row-window-a').getByTestId('chip-here')).toHaveCount(0);
    const shots = process.env.E2E_SHOTS ?? resolve('test-results/current-window');
    mkdirSync(shots, { recursive: true });
    await pageB.screenshot({ path: join(shots, 'window-b-badge.png') });

    // Remove B's shortcut, then save it through the contextual add UI, not a direct router call.
    await pageB.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'account.remove', accountId: 'window-b' }),
    );
    await pageB.reload();
    await expect(pageB.getByTestId('row-window-b')).toHaveCount(0);
    await pageB.getByTestId('add-account').click();
    await pageB.getByTestId('add-input').fill('Window B saved');
    await pageB.getByTestId('add-save').click();
    const savedB = pageB.locator('[data-testid^="row-"]').filter({ hasText: 'Window B saved' });
    await expect(savedB.getByTestId('chip-here')).toHaveText('On this tab');
    const accounts = await sw.evaluate(
      async () => ((await chrome.storage.local.get('store')).store as StoreV1).accounts,
    );
    expect(
      accounts.find((account: { label: string }) => account.label === 'Window B saved'),
    ).toMatchObject({ youtube: { authuser: 2 } });
    await pageB.screenshot({ path: join(shots, 'window-b-added.png') });
    await pageB.close();

    const pageA = await popupOver(tabA?.id as number);
    await expect(pageA.getByTestId('row-window-a').getByTestId('chip-here')).toHaveText(
      'On this tab',
    );
    await expect(pageA.getByTestId('chip-here')).toHaveCount(1);
    await pageA.screenshot({ path: join(shots, 'window-a-badge.png') });
    await pageA.close();
    console.log(`two-window probe/add: A=${tabA?.id}, B=${tabB?.id}, saved B authuser=2; PASS`);
  } finally {
    await close?.();
    await sites.close();
  }
});
