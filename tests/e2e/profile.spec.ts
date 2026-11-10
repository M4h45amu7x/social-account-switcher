import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPageProfile } from '../../src/background/profile';
import { sanitizeProfile } from '../../src/lib/profile';
import type { StoreV1 } from '../../src/lib/store';
import { PNG } from '../fixtures/profile';
import { expect, test } from './fixtures';
import { launchWithSites } from './https-sites';

for (const platform of ['facebook', 'instagram', 'youtube'] as const) {
  test(`${platform}: local profile prefill, avatar, custom rename/update, mismatch and literal HTML`, async () => {
    const host = `www.${platform}.com`;
    let name = 'Alice Profile';
    let id = '1001';
    let handle = '@alice';
    const launched = await launchWithSites([host], (_req, res) => {
      const json =
        platform === 'facebook'
          ? `<script type="application/json" data-sjs>${JSON.stringify({ define: [['CurrentUserInitialData', [], { USER_ID: id, NAME: name, USERNAME: handle, PROFILE_PICTURE: PNG }]] })}</script>`
          : platform === 'instagram'
            ? `<script type="application/json">${JSON.stringify({ config: { viewer: { id, full_name: name, username: handle, profile_pic_url: PNG } } })}</script>`
            : `<script>var ytcfg={get:k=>(${JSON.stringify({ SESSION_INDEX: '0', ACCOUNT_NAME: name, CHANNEL_HANDLE: handle, EMAIL: 'alice@example.test', AVATAR_URL: PNG })})[k]}</script>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8">${json}`);
    });
    try {
      const { context } = launched;
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup/index.html`;
      const setup = await context.newPage();
      await setup.goto(popupUrl);
      await setup.getByTestId('pw-input').fill('orange cat naps by the canal');
      await setup.getByTestId('setup-create').click();
      await expect(setup.getByTestId('popup')).toHaveAttribute('data-state', 'empty');
      await setup.close();
      if (platform !== 'youtube')
        await context.addCookies([
          {
            name: platform === 'facebook' ? 'c_user' : 'ds_user_id',
            value: '1001',
            domain: `.${platform}.com`,
            path: '/',
            secure: true,
          },
          {
            name: platform === 'facebook' ? 'xs' : 'sessionid',
            value: 'fixture-session',
            domain: `.${platform}.com`,
            path: '/',
            secure: true,
            httpOnly: true,
          },
        ]);
      const site = await context.newPage();
      await site.goto(`https://${host}/`);
      const tabId = await sw.evaluate(
        async (host) => (await chrome.tabs.query({ url: `https://${host}/*` }))[0]?.id,
        host,
      );
      const opened = context.waitForEvent('page');
      await sw.evaluate(
        async ({ tabId, popupUrl }) => {
          if (tabId === undefined) throw new Error('missing site tab');
          const t = await chrome.tabs.get(tabId);
          await chrome.tabs.create({ windowId: t.windowId, url: popupUrl, active: false });
        },
        { tabId, popupUrl },
      );
      const popup = await opened;
      const remote: string[] = [];
      context.on('request', (r) => {
        if ((r.serviceWorker() || r.frame().page() === popup) && /^https?:/.test(r.url()))
          remote.push(r.url());
      });
      await popup.getByTestId('add-account').click();
      await expect(popup.getByTestId('add-input')).toHaveValue('Alice Profile');
      await popup.getByTestId('add-save').click();
      const row = popup.locator('[data-testid^="row-"]');
      await expect(row.locator('.nm')).toHaveText('Alice Profile');
      await expect(row.locator('.profile-details')).toContainText('@alice');
      await expect(row.locator('.avatar > img')).toHaveAttribute('src', PNG);
      await expect
        .poll(() =>
          row
            .locator('.avatar > img')
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
      await row.locator('[data-act="rename"]').click();
      await popup.getByTestId('rename-input').fill('My chosen name');
      await popup.getByTestId('rename-save').click();
      const accountId = await row.getAttribute('data-id');
      name = 'New display name';
      handle = '@new';
      await site.reload();
      const update = () =>
        popup.evaluate(
          ({ accountId, tabId }) =>
            chrome.runtime.sendMessage({ type: 'account.updateSession', accountId, tabId }),
          { accountId, tabId },
        );
      expect(await update()).toMatchObject({ ok: true });
      await popup.reload();
      await expect(row.locator('.nm')).toHaveText('My chosen name');
      await expect(row.locator('.profile-details')).toContainText('@new');
      const shots = resolve(process.env.E2E_SHOTS ?? 'test-results/profile');
      mkdirSync(shots, { recursive: true });
      for (const theme of ['light', 'dark'] as const) {
        await popup.evaluate(
          (theme) => chrome.runtime.sendMessage({ type: 'settings.set', theme }),
          theme,
        );
        await popup.reload();
        await expect(row.locator('.nm')).toHaveText('My chosen name');
        await expect(row.locator('.profile-details')).toContainText('@new');
        // Wait for the initial state/view transition before retaining visual evidence.
        await expect.poll(() => popup.evaluate(() => document.getAnimations().length)).toBe(0);
        await popup.screenshot({
          path: resolve(shots, `${platform}-${theme}.png`),
          animations: 'disabled',
        });
      }
      if (platform !== 'youtube') {
        id = '9999';
        name = 'Wrong account';
        await site.reload();
        expect(await update()).toMatchObject({ ok: true });
        await popup.reload();
        await expect(row.locator('.profile-details')).toBeEmpty();
        expect(
          await sw.evaluate(
            async () => ((await chrome.storage.local.get('store')).store as StoreV1).accounts[0],
          ),
        ).not.toHaveProperty('profile');
      }
      await popup.evaluate(
        (accountId) => chrome.runtime.sendMessage({ type: 'account.remove', accountId }),
        accountId,
      );
      id = '1001';
      name = '<img src=x onerror=alert(1)>';
      handle = '<svg onload=alert(1)>';
      await site.reload();
      await popup.reload();
      await popup.getByTestId('add-account').click();
      await expect(popup.getByTestId('add-input')).toHaveValue(name);
      await popup.getByTestId('add-save').click();
      await expect(row.locator('.nm')).toHaveText(name);
      await expect(row.locator('.profile-details')).toContainText(handle);
      await expect(row.locator('.who img, .profile-details svg')).toHaveCount(0);
      expect(remote).toEqual([]);
    } finally {
      await launched.close();
    }
  });
}

test('already loaded avatar pixels are downsampled; tainted or unloaded images fall back without requests', async () => {
  const host = 'www.instagram.com';
  const cdn = 'avatar.example.test';
  const launched = await launchWithSites([host, cdn], (_req, res, url) => {
    if (url.pathname === '/avatar.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect width="128" height="96" fill="green"/></svg>',
      );
      return;
    }
    const avatar = `https://${url.searchParams.has('foreign') ? cdn : host}/avatar.svg`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<script>var _sharedData={config:{viewer:{id:'2001',full_name:'Viewer',profile_pic_url:${JSON.stringify(avatar)}}}}</script><img src="${avatar}">`,
    );
  });
  try {
    const page = await launched.context.newPage();
    for (const foreign of [false, true]) {
      await page.goto(`https://${host}/${foreign ? '?foreign=1' : ''}`);
      await expect
        .poll(() =>
          page
            .locator('img')
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 128),
        )
        .toBe(true);
      const requests: string[] = [];
      const listener = (request: { url(): string }) => requests.push(request.url());
      page.on('request', listener);
      const result = (await page.evaluate(readPageProfile)) as {
        identity: string;
        profile: unknown;
      };
      expect(result.identity).toBe('2001');
      const profile = sanitizeProfile(result.profile);
      expect(profile?.displayName).toBe('Viewer');
      if (foreign) expect(profile).not.toHaveProperty('avatar');
      else {
        expect(profile?.avatar).toMatch(/^data:image\/png;base64,/);
        const bytes = Buffer.from(profile?.avatar?.split(',')[1] ?? '', 'base64');
        expect(bytes.readUInt32BE(16)).toBe(64);
        expect(bytes.readUInt32BE(20)).toBe(48);
      }
      await page.evaluate(() => {
        Object.assign(globalThis, {
          _sharedData: {
            config: {
              viewer: {
                id: '2001',
                full_name: 'Viewer',
                profile_pic_url: 'https://never-load.test/avatar.png',
              },
            },
          },
        });
      });
      expect(await page.evaluate(readPageProfile)).toEqual({
        identity: '2001',
        profile: { displayName: 'Viewer' },
      });
      expect(requests).toEqual([]);
      page.off('request', listener);
    }
  } finally {
    await launched.close();
  }
});
