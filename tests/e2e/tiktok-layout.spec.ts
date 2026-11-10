// Fictional sample states exercise the shipped renderer/catalogs; production flows have a separate spec.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPopup, open, popupTest as test } from './popup-build';

const { expect } = test;
test.beforeAll(() => buildPopup());
for (const lang of ['en', 'th'])
  for (const theme of ['light', 'dark'])
    test(`TikTok ${lang} ${theme}: list, empty and unknown error fit at 360px`, async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const state of ['tt-list', 'tt-empty', 'tt-error']) {
        await open(page, extensionId, { state, lang, theme });
        await expect(page.getByTestId('tab-tiktok')).toHaveAttribute('aria-selected', 'true');
        if (state === 'tt-list') await expect(page.getByTestId('chip-here')).toHaveCount(1);
        if (state === 'tt-error') {
          await expect(page.getByTestId('notice')).toHaveAttribute(
            'data-code',
            'tiktok_probe_unavailable',
          );
          await expect(page.locator('.chip.bad')).toHaveCount(0);
        }
        const overflow = await page.evaluate(() => {
          const app = document.getElementById('app');
          if (!app) return ['missing app'];
          const box = app.getBoundingClientRect();
          return [...app.querySelectorAll<HTMLElement>('*')].flatMap((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return [];
            const decorated = el.matches('.avatar') || el.querySelector('.avatar') !== null;
            // Only the footer copy intentionally ellipsizes. Its full text remains accessible.
            const style = getComputedStyle(el);
            const ellipsis =
              el.matches('footer.foot > .foot-copy') &&
              style.overflowX === 'hidden' &&
              style.textOverflow === 'ellipsis' &&
              style.whiteSpace === 'nowrap' &&
              el.title === el.textContent;
            return r.right > box.right + 1 ||
              r.left < box.left - 1 ||
              (!decorated && !ellipsis && el.scrollWidth > el.clientWidth + 1) ||
              (!decorated && el.scrollHeight > el.clientHeight + 1)
              ? [`${el.tagName}.${el.className}`]
              : [];
          });
        });
        expect(overflow).toEqual([]);
        const shots = process.env.E2E_TIKTOK_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: resolve(shots, `${state}-${lang}-${theme}.png`),
            fullPage: true,
          });
        }
      }
      await page.close();
    });
