// Four real platform tabs: a visible name must fit in full; inactive names are hidden as a whole.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPopup, idle, open, popupTest as test } from './popup-build';

const { expect } = test;
test.beforeAll(() => buildPopup());
for (const lang of ['en', 'th'])
  for (const theme of ['light', 'dark']) {
    test(`${lang} ${theme}: four wide-font tabs preserve full selected names and keyboard navigation`, async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, extensionId, { state: 'list', lang, theme });
      await page.evaluate(async () => {
        const font = new FontFace('TabWide', 'local("DejaVu Sans")');
        document.fonts.add(await font.load());
      });
      await page.addStyleTag({
        content: '.tab, .tab * { font-family: TabWide, sans-serif !important; }',
      });
      await expect(page.locator('.tabs .tab')).toHaveCount(4);
      for (const platform of ['facebook', 'instagram', 'youtube', 'tiktok']) {
        await page.getByTestId(`tab-${platform}`).click();
        await idle(page);
        await page.locator('.tab .count').evaluateAll((counts) => {
          for (const c of counts) c.textContent = '99';
        });
        const layout = await page.evaluate(() => {
          const out: string[] = [];
          const gaps: { tab: string; from: string; to: string; gap: number }[] = [];
          for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
            const box = tab.getBoundingClientRect();
            const label = tab.querySelector<HTMLElement>('.label');
            const count = tab.querySelector<HTMLElement>('.count');
            const mark = tab.querySelector('.mark')?.getBoundingClientRect();
            if (!label || !count || !mark) throw Error('missing tab contents');
            if (mark.width !== 16 || mark.height !== 16) out.push('icon shrunk');
            if (tab.scrollWidth > tab.clientWidth + 1) out.push('tab overflow');
            if (
              tab.title !== label.textContent ||
              tab.getAttribute('aria-label') !== label.textContent
            )
              out.push('missing full name');
            const visible = getComputedStyle(label).display !== 'none';
            const labelBox = label.getBoundingClientRect();
            const countBox = count.getBoundingClientRect();
            const pairs = visible
              ? [
                  { from: 'icon', to: 'label', gap: labelBox.left - mark.right },
                  { from: 'label', to: 'count', gap: countBox.left - labelBox.right },
                ]
              : [{ from: 'icon', to: 'count', gap: countBox.left - mark.right }];
            for (const pair of pairs) {
              gaps.push({ tab: tab.dataset.tab ?? '', ...pair });
              if (pair.gap < 5)
                out.push(`${tab.dataset.tab}: ${pair.from}→${pair.to} gap=${pair.gap}px <5px`);
            }
            if (Math.abs((mark.left + countBox.right) / 2 - (box.left + box.right) / 2) > 1)
              out.push('contents not centered');
            for (const r of [mark, countBox, ...(visible ? [labelBox] : [])])
              if (Math.abs((r.top + r.bottom) / 2 - (box.top + box.bottom) / 2) > 1)
                out.push('contents not vertically centered');
            if (visible) {
              if (label.scrollWidth > label.clientWidth + 1) out.push('name clipped');
              if (label.getBoundingClientRect().right > count.getBoundingClientRect().left)
                out.push('name overlaps count');
            }
            if (visible !== (tab.getAttribute('aria-selected') === 'true'))
              out.push('selected name visibility');
            for (const child of tab.children) {
              if (getComputedStyle(child).display === 'none') continue;
              const r = child.getBoundingClientRect();
              if (
                r.left < box.left - 0.5 ||
                r.right > box.right + 0.5 ||
                r.top < box.top - 0.5 ||
                r.bottom > box.bottom + 0.5
              )
                out.push('child outside tab');
            }
            if (count.scrollWidth > count.clientWidth || count.scrollHeight > count.clientHeight)
              out.push('count clipped');
          }
          const selected = document
            .querySelector('.tab[aria-selected="true"]')
            ?.getBoundingClientRect();
          const thumb = document.querySelector('.tabs .thumb')?.getBoundingClientRect();
          if (
            !selected ||
            !thumb ||
            Math.abs(selected.left - thumb.left) > 1 ||
            Math.abs(selected.width - thumb.width) > 1
          )
            out.push('thumb misplaced');
          return { errors: out, gaps };
        });
        const shots = process.env.E2E_TAB_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({
            path: resolve(shots, `tabs-${lang}-${theme}-${platform}.png`),
            fullPage: true,
          });
          writeFileSync(
            resolve(shots, `tabs-${lang}-${theme}-${platform}.json`),
            JSON.stringify(layout, null, 2),
          );
        }
        expect.soft(layout.errors).toEqual([]);
      }
      await page.getByTestId('tab-tiktok').focus();
      await page.keyboard.press('Home');
      await idle(page);
      await expect(page.getByTestId('tab-facebook')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('tab-facebook').focus();
      await page.keyboard.press('End');
      await idle(page);
      await expect(page.getByTestId('tab-tiktok')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('tab-tiktok').focus();
      await page.keyboard.press('ArrowRight');
      await idle(page);
      await expect(page.getByTestId('tab-facebook')).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('tab-facebook').focus();
      await page.keyboard.press('ArrowLeft');
      await idle(page);
      await expect(page.getByTestId('tab-tiktok')).toHaveAttribute('aria-selected', 'true');
      expect(
        await page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((a) => (a.effect as KeyframeEffect)?.target?.classList?.contains('thumb'))
              .length,
        ),
      ).toBe(0);
      await page.close();
    });
  }

test('normal motion: consecutive keyboard selections keep focus after redraw', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light' });
  await page.getByTestId('tab-facebook').focus();
  await page.keyboard.press('ArrowRight');
  await idle(page);
  await expect(page.getByTestId('tab-instagram')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await idle(page);
  await expect(page.getByTestId('tab-youtube')).toBeFocused();
  await page.keyboard.press('End');
  await idle(page);
  await expect(page.getByTestId('tab-tiktok')).toBeFocused();
  await page.close();
});
