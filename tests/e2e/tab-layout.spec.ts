// Exercise the real tab markup with a wide system font and a test-only fourth tab.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPopup, idle, open, popupTest as test } from './popup-build';

const { expect } = test;
test.beforeAll(() => buildPopup());

for (const lang of ['en', 'th']) {
  for (const theme of ['light', 'dark']) {
    test(`${lang} ${theme}: wide font keeps names, icons and counts inside three and four tabs`, async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await open(page, extensionId, { state: 'list', lang, theme });
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByTestId('tab-instagram').click();
      await idle(page);
      await page.evaluate(async () => {
        const font = new FontFace('TabWide', 'local("DejaVu Sans")');
        document.fonts.add(await font.load());
      });
      await page.addStyleTag({
        content: '.tab, .tab * { font-family: TabWide, sans-serif !important; }',
      });
      for (const n of [3, 4]) {
        if (n === 4) {
          await page.evaluate(() => {
            const nav = document.querySelector<HTMLElement>('.tabs');
            const source = nav?.querySelector('.tab');
            if (!nav || !source) throw new Error('missing tabs');
            const fourth = source.cloneNode(true) as HTMLElement;
            fourth.removeAttribute('data-testid');
            fourth.removeAttribute('data-tab');
            fourth.removeAttribute('aria-describedby');
            fourth.querySelector('.count')?.removeAttribute('id');
            fourth.setAttribute('aria-selected', 'false');
            nav.append(fourth);
            nav.style.setProperty('--n', '4');
          });
        }
        // Include a two-digit count, not just the zero in an empty vault.
        await page.locator('.tab .count').evaluateAll((counts) => {
          for (const count of counts) count.textContent = '99';
        });
        const failures = await page.evaluate(() => {
          const errors: string[] = [];
          let shortened = 0;
          for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
            const box = tab.getBoundingClientRect();
            const label = tab.querySelector<HTMLElement>('span:not(.count)');
            const count = tab.querySelector<HTMLElement>('.count');
            const icon = tab.querySelector('.mark');
            const mark = icon?.getBoundingClientRect();
            if (!mark || mark.width !== 16 || mark.height !== 16) errors.push('icon shrunk');
            if (!label || !count) throw new Error('missing tab contents');
            if (tab.scrollWidth > tab.clientWidth + 1) errors.push('tab scroll overflow');
            if (label.clientWidth <= 0) errors.push('name has no space');
            if (tab.title !== label.textContent) errors.push('full name missing from title');
            if (tab.getAttribute('aria-label') !== label.textContent)
              errors.push('full accessible name missing');
            for (const child of tab.children) {
              const r = child.getBoundingClientRect();
              if (
                r.left < box.left ||
                r.right > box.right ||
                r.top < box.top ||
                r.bottom > box.bottom
              ) {
                errors.push(`child outside tab: ${child.tagName}.${child.className}`);
              }
            }
            if (label.getBoundingClientRect().right > count.getBoundingClientRect().left) {
              errors.push('name overlaps count');
            }
            if (count.scrollWidth > count.clientWidth || count.scrollHeight > count.clientHeight) {
              errors.push('count clipped');
            }
            if (label.scrollWidth > label.clientWidth) {
              shortened++;
              const css = getComputedStyle(label);
              if (
                css.textOverflow !== 'ellipsis' ||
                css.overflow !== 'hidden' ||
                css.whiteSpace !== 'nowrap'
              ) {
                errors.push('narrow name has no ellipsis');
              }
            }
          }
          if (document.querySelectorAll('.tab').length === 4 && shortened === 0) {
            errors.push('four-tab case did not exercise ellipsis');
          }
          return errors;
        });
        expect(failures).toEqual([]);
        const shots = process.env.E2E_TAB_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: resolve(shots, `tabs-${lang}-${theme}-${n}.png`),
            fullPage: true,
          });
        }
      }
      await page.close();
    });
  }
}
