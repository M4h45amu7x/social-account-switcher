import type { Page } from '@playwright/test';
import type { StoreV1 } from '../../src/lib/store';
import { PNG } from '../fixtures/profile';
import { expect, test } from './fixtures';
import { launchWithSites } from './https-sites';

async function profileRig(platform: 'facebook' | 'instagram', avatar = () => PNG) {
  const host = `www.${platform}.com`;
  const other = 'unrelated.example.test';
  const launched = await launchWithSites([host, other], (_req, res, url) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const json =
      platform === 'facebook'
        ? `<script type="application/json" data-sjs>${JSON.stringify({ define: [['CurrentUserInitialData', [], { USER_ID: '1001', NAME: 'Matched Alice', USERNAME: '@alice', PROFILE_PICTURE: avatar() }]] })}</script>`
        : `<script type="application/json">${JSON.stringify({ config: { viewer: { id: '1001', full_name: 'Matched Alice', username: '@alice', profile_pic_url: avatar() } } })}</script>`;
    res.end(
      `<!doctype html><meta charset="utf-8">${url.hostname === host ? json : 'Unrelated site'}`,
    );
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
        value: 'fixture-only',
        domain: `.${platform}.com`,
        path: '/',
        secure: true,
        httpOnly: true,
      },
    ]);
    const site = await context.newPage();
    await site.goto(`https://${host}/`);
    const offsite = await context.newPage();
    await offsite.goto(`https://${other}/`);
    const popupOver = async (tab: Page) => {
      await tab.bringToFront();
      const opened = context.waitForEvent('page');
      await sw.evaluate((url) => chrome.tabs.create({ url, active: false }), popupUrl);
      const popup = await opened;
      await expect(popup.getByTestId('popup')).not.toHaveAttribute('data-state', 'loading');
      await popup.getByTestId(`tab-${platform}`).click();
      return popup;
    };
    const accounts = () =>
      sw.evaluate(
        async () => ((await chrome.storage.local.get('store')).store as StoreV1).accounts,
      );
    return { ...launched, site, offsite, popupOver, accounts };
  } catch (error) {
    await launched.close();
    throw error;
  }
}

for (const platform of ['facebook', 'instagram'] as const) {
  test(`${platform}: Add over an unrelated site saves cookies without borrowing metadata; on-site Add gets profile`, async () => {
    const h = await profileRig(platform);
    try {
      let popup = await h.popupOver(h.offsite);
      await popup.getByTestId('add-account').click();
      await expect(popup.getByTestId('add-input')).toBeVisible();
      await expect(popup.getByTestId('add-input')).not.toHaveValue('Matched Alice');
      await popup.getByTestId('add-save').click();
      await expect(popup.locator('[data-testid^="row-"]')).toHaveCount(1);
      const offsiteAccount = (await h.accounts())[0];
      expect(offsiteAccount).toMatchObject({ platform, platformUserId: '1001' });
      expect(offsiteAccount).not.toHaveProperty('profile');
      await popup.evaluate(
        (accountId) => chrome.runtime.sendMessage({ type: 'account.remove', accountId }),
        offsiteAccount?.id,
      );
      await popup.close();
      popup = await h.popupOver(h.site);
      await popup.getByTestId('add-account').click();
      await expect(popup.getByTestId('add-input')).toHaveValue('Matched Alice');
      await popup.getByTestId('add-save').click();
      // The Add preview also has .profile-details; wait for the saved row before reading storage.
      await expect(popup.locator('[data-testid^="row-"] .profile-details')).toContainText('@alice');
      expect((await h.accounts())[0]?.profile).toMatchObject({
        displayName: 'Matched Alice',
        handle: '@alice',
      });
    } finally {
      await h.close();
    }
  });
}

for (const kind of ['png', 'jpeg', 'webp'] as const) {
  test(`${kind}: Add stores only re-encoded pixels, never polyglot, header-only or truncated source bytes`, async () => {
    test.setTimeout(60_000);
    let avatar = PNG;
    const h = await profileRig('facebook', () => avatar);
    try {
      const valid = await h.site.evaluate((kind) => {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('missing browser canvas');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 2, 2);
        return canvas.toDataURL(`image/${kind}`);
      }, kind);
      expect(valid).toMatch(new RegExp(`^data:image/${kind};base64,`));
      const bytes = Buffer.from(valid.split(',')[1] ?? '', 'base64');
      const payload = '<html><script>avatar_payload()</script></html>';
      for (const [name, input] of [
        ['valid', bytes],
        ['polyglot', Buffer.concat([bytes, Buffer.from(payload)])],
        ['header', bytes.subarray(0, kind === 'webp' ? 30 : 33)],
        ['truncated', bytes.subarray(0, Math.floor(bytes.length / 2))],
      ] as const) {
        avatar = `data:image/${kind};base64,${input.toString('base64')}`;
        await h.site.reload();
        const popup = await h.popupOver(h.site);
        const requests: string[] = [];
        const request = (r: { url(): string }) => {
          if (/^https?:/.test(r.url())) requests.push(r.url());
        };
        h.context.on('request', request);
        await popup.getByTestId('add-account').click();
        await expect(popup.getByTestId('add-input')).toHaveValue('Matched Alice');
        await popup.getByTestId('add-save').click();
        const row = popup.locator('[data-testid^="row-"]');
        await expect(row).toHaveCount(1);
        const account = (await h.accounts())[0];
        const saved = account?.profile?.avatar;
        if (name === 'valid') expect(saved).toMatch(/^data:image\/png;base64,/);
        if (name === 'header' || name === 'truncated') expect(saved).toBeUndefined();
        if (saved) {
          expect(Buffer.from(saved.split(',')[1] ?? '', 'base64').toString('latin1')).not.toContain(
            'avatar_payload',
          );
          if (name === 'polyglot' || kind !== 'png') expect(saved).not.toBe(avatar);
          await expect(row.locator('.avatar > img')).toHaveAttribute('src', saved);
          await expect
            .poll(() =>
              row
                .locator('.avatar > img')
                .evaluate((img: HTMLImageElement) => `${img.naturalWidth}x${img.naturalHeight}`),
            )
            .toBe('2x2');
        } else await expect(row.locator('.avatar > img')).toHaveCount(0);
        expect(requests).toEqual([]);
        h.context.off('request', request);
        await popup.evaluate(
          (accountId) => chrome.runtime.sendMessage({ type: 'account.remove', accountId }),
          account?.id,
        );
        await popup.close();
      }
    } finally {
      await h.close();
    }
  });
}
