// Production popup: profile rows and all four platform tabs share the 360px layout.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { addAccount, PLATFORMS, type StoreV1 } from '../../src/lib/store';
import { PNG } from '../fixtures/profile';
import { expect, test } from './fixtures';

for (const language of ['en', 'th'] as const)
  for (const theme of ['light', 'dark'] as const) {
    test(`profile layout: ${language} ${theme}, four platforms at 360px with DejaVu tabs`, async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 600 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
      await page.getByTestId('pw-input').fill('orange cat naps by the canal');
      await page.getByTestId('setup-create').click();
      await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'empty');
      let store = await page.evaluate(
        async () => (await chrome.storage.local.get('store')).store as StoreV1,
      );
      for (const platform of PLATFORMS) {
        const added = addAccount(
          store,
          {
            platform,
            label: 'A long custom account name in the layout',
            labelSource: 'custom',
            ...(platform === 'youtube' ? { youtube: { authuser: 0 } } : { platformUserId: '1001' }),
            profile: {
              displayName: `${platform} Profile`,
              handle: `@${platform}_a_long_viewer_handle_for_layout`,
              ...(platform === 'youtube' ? { email: 'viewer@example.test' } : {}),
              avatar: PNG,
            },
          },
          { id: platform, now: 1 },
        );
        if (!added.ok) throw new Error(added.error);
        store = added.value.store;
      }
      store.settings = { language, theme };
      await page.evaluate((store) => chrome.storage.local.set({ store }), store);
      await page.reload();
      await expect(page.locator('.tabs .tab')).toHaveCount(4);
      await page.evaluate(async () => {
        const font = new FontFace('TabWide', 'local("DejaVu Sans")');
        document.fonts.add(await font.load());
      });
      await page.addStyleTag({
        content: '.tab, .tab * { font-family: TabWide, sans-serif !important; }',
      });
      for (const platform of PLATFORMS) {
        await page.getByTestId(`tab-${platform}`).click();
        const row = page.getByTestId(`row-${platform}`);
        await expect(row.locator('.nm')).toHaveText('A long custom account name in the layout');
        await expect(row.locator('.profile-details')).toContainText(`@${platform}_`);
        await expect
          .poll(() =>
            row
              .locator('.avatar > img')
              .evaluate((img: HTMLImageElement) => Boolean(img.complete && img.naturalWidth > 0)),
          )
          .toBe(true);
        await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
        const errors = await row.evaluate((row) => {
          const out: string[] = [];
          const box = row.getBoundingClientRect();
          if (document.documentElement.scrollWidth > 360 || box.right > 360)
            out.push('horizontal overflow');
          for (const selector of ['.avatar', '.who', '.nm', '.profile-details']) {
            const el = row.querySelector<HTMLElement>(selector);
            if (!el) throw new Error(`missing ${selector}`);
            const rect = el.getBoundingClientRect();
            if (rect.left < box.left || rect.right > box.right || rect.bottom > box.bottom)
              out.push(`${selector} outside row`);
            if (selector === '.avatar' && (rect.width < 32 || rect.height < 32))
              out.push('avatar shrunk');
          }
          const tab = document.querySelector<HTMLElement>('.tab[aria-selected="true"]');
          const label = tab?.querySelector<HTMLElement>('.label');
          const count = tab?.querySelector('.count');
          if (!tab || !label || !count) throw new Error('missing selected tab');
          if (label.scrollWidth > label.clientWidth + 1 || tab.scrollWidth > tab.clientWidth + 1)
            out.push('selected tab clipped');
          if (label.getBoundingClientRect().right > count.getBoundingClientRect().left)
            out.push('tab name overlaps count');
          return out;
        });
        expect(errors).toEqual([]);
        const shots = process.env.E2E_PROFILE_LAYOUT_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: resolve(shots, `${language}-${theme}-${platform}.png`),
            fullPage: true,
          });
        }
      }
      await page.close();
    });
  }
