// Screenshots of the real popup talking to the real worker (locked, list, YouTube error, settings),
// English and Thai, light and dark. Skipped unless SHOTS=1: `SHOTS=1 bunx playwright test wired-shots`.
// They land in mockup/shots/wired/.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const out = resolve(import.meta.dirname, '..', '..', 'mockup', 'shots', 'wired');
const PASSWORD = 'orange cat naps by the canal';

test.skip(process.env.SHOTS !== '1', 'screenshots only with SHOTS=1');

for (const lang of ['en', 'th'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`wired popup ${lang} ${theme}`, async ({ context, extensionId }) => {
      mkdirSync(out, { recursive: true });
      await context.route('https://www.facebook.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Fixture</title><link rel="icon" href="data:,">',
        }),
      );
      const site = await context.newPage();
      await site.goto('https://www.facebook.com/');
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 520 });
      await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
      await page.evaluate(async () => {
        const [site] = await chrome.tabs.query({
          url: 'https://www.facebook.com/*',
          currentWindow: true,
        });
        if (site?.id === undefined) throw new Error('missing Facebook fixture tab');
        await chrome.tabs.update(site.id, { active: true });
      });
      await page.reload();
      const popup = page.getByTestId('popup');
      const shot = (name: string) =>
        page.screenshot({ path: resolve(out, `${name}.${lang}.${theme}.png`) });
      const settle = async (p: Page) => {
        await p.waitForFunction(() => !document.documentElement.dataset.vtBusy);
        await p.waitForTimeout(250);
      };

      await expect(popup).toHaveAttribute('data-state', 'setup');
      await settle(page);
      await shot('setup');
      await page.getByTestId('pw-input').fill(PASSWORD);
      await page.getByTestId('setup-create').click();
      await expect(popup).toHaveAttribute('data-state', 'empty');

      await page.getByTestId('settings-btn').click();
      await page.getByTestId(`s-theme-${theme}`).click();
      await page.getByTestId(`s-lang-${lang}`).click();
      await settle(page);
      await shot('settings');
      await page.getByTestId('settings-back').click();

      for (const [user, name] of [
        ['100012345678', lang === 'th' ? 'ส่วนตัว' : 'Personal'],
        ['100087654321', lang === 'th' ? 'ร้านขนมบ้านส้ม' : 'Orange Bakery'],
      ] as const) {
        await context.addCookies([
          { name: 'c_user', value: user, domain: '.facebook.com', path: '/', secure: true },
          {
            name: 'xs',
            value: `session-${user}`,
            domain: '.facebook.com',
            path: '/',
            secure: true,
          },
        ]);
        await page.getByTestId('add-account').click();
        await page.getByTestId('add-input').fill(name);
        await page.getByTestId('add-save').click();
        await expect(popup).toHaveAttribute('data-state', 'list');
      }
      await settle(page);
      await shot('list');

      // The captured Facebook tab is not a YouTube session; show the sign-in hint.
      await page.getByTestId('tab-youtube').click();
      await page.getByTestId('add-account').click();
      await expect(page.getByTestId('add-not-logged-in')).toBeVisible();
      await settle(page);
      await shot('youtube-error');

      await page.getByTestId('tab-facebook').click();
      await page.getByTestId('settings-btn').click();
      await page.getByTestId('lock-now').click();
      await expect(popup).toHaveAttribute('data-state', 'locked');
      await settle(page);
      await shot('locked');
    });
  }
}
