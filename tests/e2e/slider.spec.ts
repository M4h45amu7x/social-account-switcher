// Card t-591: the tab bar and the segmented controls slide one thumb behind their labels, and the panel
// transition never shows the old and the new page at once. Animations are frozen at a chosen time
// (document.getAnimations(), which also lists the ::view-transition ones) and the frame is inspected.
import type { Page } from '@playwright/test';
import { buildPopup, idle, open, popupTest as test } from './popup-build';

const { expect } = test;
const THEMES = ['light', 'dark'] as const;

test.beforeAll(() => buildPopup());

/** From now on every new animation is paused as soon as it exists; `at(ms)` then moves them all to one time. */
async function armFreeze(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __seen: WeakSet<Animation>; __stop: boolean };
    w.__seen = new WeakSet();
    w.__stop = false;
    const tick = () => {
      for (const a of document.getAnimations()) {
        if (w.__seen.has(a)) continue;
        w.__seen.add(a);
        a.pause();
        a.currentTime = 0;
      }
      if (!w.__stop) requestAnimationFrame(tick);
    };
    tick();
  });
}
const frozenCount = (page: Page) =>
  page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'paused').length);
async function at(page: Page, ms: number) {
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
}
async function thaw(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __stop: boolean }).__stop = true;
    for (const a of document.getAnimations()) a.play();
  });
  await idle(page);
}

/** Number of "ink" pixels (clearly different from the area's most common colour) inside a rectangle. */
async function ink(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const png = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const lum = (i: number) =>
      0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);
    const hist = new Map<number, number>();
    for (let i = 0; i < d.length; i += 4) {
      const k = Math.round(lum(i) / 4);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
    let mode = 0;
    let best = -1;
    for (const [k, n] of hist)
      if (n > best) {
        best = n;
        mode = k;
      }
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(lum(i) - mode * 4) > 60) n++;
    return n;
  }, png.toString('base64'));
}

const label = (tab: string) => `[data-testid="tab-${tab}"] > span:not(.count)`;

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test('tab switch: every tab name stays readable while the thumb is half way', async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 640 });
      await open(page, extensionId, { state: 'list', lang: 'en', theme });
      await armFreeze(page);
      await page.getByTestId('tab-instagram').click();
      await expect.poll(() => frozenCount(page)).toBeGreaterThan(0);
      await at(page, 210);
      // no element inside the tab bar is lifted into the view-transition layer (that layer paints over the labels)
      const named = await page.evaluate(() =>
        [...document.querySelectorAll('.tabs, .tabs *')]
          .filter((e) => getComputedStyle(e).viewTransitionName !== 'none')
          .map((e) => e.className || e.tagName),
      );
      const mid = {
        facebook: await ink(page, label('facebook')),
        instagram: await ink(page, label('instagram')),
      };
      await page.screenshot({
        path: `${process.env.E2E_SHOTS ?? 'test-results/popup-shots'}/tabs-mid.${theme}.png`,
        clip: { x: 0, y: 0, width: 360, height: 180 },
      });
      await thaw(page);
      await page.screenshot({
        path: `${process.env.E2E_SHOTS ?? 'test-results/popup-shots'}/tabs-after.${theme}.png`,
        clip: { x: 0, y: 0, width: 360, height: 180 },
      });
      // the same labels once everything has settled: half way must show (nearly) as much text
      const done = {
        facebook: await ink(page, label('facebook')),
        instagram: await ink(page, label('instagram')),
      };
      expect(done.facebook).toBeGreaterThan(40);
      expect(mid.facebook, 'Facebook label ink at 50%').toBeGreaterThanOrEqual(
        done.facebook * 0.85,
      );
      expect(mid.instagram, 'Instagram label ink at 50%').toBeGreaterThanOrEqual(
        done.instagram * 0.85,
      );
      expect(named, 'elements lifted into the view-transition layer').toEqual([]);
    });

    test('the thumb is raised from its track and keeps the text readable', async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await open(page, extensionId, { state: 'list', lang: 'en', theme });
      const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lin = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const x = (v ?? 0) / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
      };
      const ratio = (a: number[], b: number[]) => {
        const [hi, lo] = [lin(a), lin(b)].sort((x, y) => y - x);
        return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
      };
      const c = await page.evaluate(() => {
        const cs = (s: string) => getComputedStyle(document.querySelector(s) as Element);
        return {
          thumb: cs('.tabs > .thumb').backgroundColor,
          track: cs('.tabs').backgroundColor,
          text: cs('.tab[aria-selected="true"]').color,
        };
      });
      expect(ratio(rgb(c.text), rgb(c.thumb))).toBeGreaterThanOrEqual(4.5);
      // the thumb must be told apart from the track: lighter in both themes than the track (dark: raised)
      expect(lin(rgb(c.thumb))).toBeGreaterThan(lin(rgb(c.track)));
    });

    test('Language and Theme segmented controls slide, then rest on the chosen cell', async ({
      context,
      extensionId,
    }) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 360, height: 640 });
      await open(page, extensionId, { state: 'settings', lang: 'en', theme });
      const dir = process.env.E2E_SHOTS ?? 'test-results/popup-shots';
      for (const group of ['language', 'theme'] as const) {
        const seg = page.locator(`.seg[data-slide="${group}"]`);
        const cells = seg.locator('button');
        const target =
          (await cells.last().getAttribute('aria-pressed')) === 'true'
            ? cells.first()
            : cells.last();
        const before = await seg.locator('.thumb').boundingBox();
        await armFreeze(page);
        await target.click();
        await expect.poll(() => frozenCount(page)).toBeGreaterThan(0);
        await at(page, 210);
        const mid = await seg.locator('.thumb').boundingBox();
        await seg.screenshot({ path: `${dir}/seg-${group}-mid.${theme}.png` });
        await thaw(page);
        await page.waitForTimeout(100);
        const after = await seg.locator('.thumb').boundingBox();
        const tb = await target.boundingBox();
        await seg.screenshot({ path: `${dir}/seg-${group}-after.${theme}.png` });
        // half way: between where it was and where it rests; at rest: exactly under the chosen cell
        const [lo, hi] = [before?.x ?? 0, after?.x ?? 0].sort((x, y) => x - y);
        expect(mid?.x).toBeGreaterThan((lo ?? 0) + 1);
        expect(mid?.x).toBeLessThan((hi ?? 0) - 1);
        expect(Math.abs((after?.x ?? 0) - (tb?.x ?? 99))).toBeLessThan(5);
        // the chosen cell's text shows (no box over it)
        expect(
          await ink(page, `.seg[data-slide="${group}"] button[aria-pressed="true"]`),
        ).toBeGreaterThan(30);
      }
    });
  });
}

test('prefers-reduced-motion: the thumb jumps, nothing animates', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, extensionId, { state: 'settings', lang: 'en', theme: 'light' });
  await page.getByTestId('s-lang-th').click();
  const running = await page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) => a.effect && (a.effect as KeyframeEffect).target?.classList?.contains('thumb'),
        ).length,
  );
  expect(running).toBe(0);
  const thumb = await page.locator('.seg[data-slide="language"] .thumb').boundingBox();
  const cell = await page.getByTestId('s-lang-th').boundingBox();
  expect(Math.abs((thumb?.x ?? 0) - (cell?.x ?? 99))).toBeLessThan(5);
});

test('panel transition: the old and the new page are never visible together', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 640 });
  await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light' });
  await armFreeze(page);
  await page.getByTestId('tab-instagram').click();
  await expect.poll(() => frozenCount(page)).toBeGreaterThan(0);
  const seen: string[] = [];
  let sawOld = false;
  let sawNew = false;
  for (let t = 0; t <= 600; t += 10) {
    await at(page, t);
    const o = await page.evaluate(() => {
      const op = (p: string) =>
        Number.parseFloat(getComputedStyle(document.documentElement, p).opacity);
      return [op('::view-transition-old(panel)'), op('::view-transition-new(panel)')];
    });
    const [oldOp = 0, newOp = 0] = o;
    if (oldOp > 0.02) sawOld = true;
    if (newOp > 0.02) sawNew = true;
    if (oldOp > 0.02 && newOp > 0.02)
      seen.push(`t=${t} old=${oldOp.toFixed(2)} new=${newOp.toFixed(2)}`);
  }
  expect(sawOld && sawNew).toBe(true);
  expect(seen).toEqual([]);
  await thaw(page);
  // after the transition nothing is left in the view-transition layer
  expect(await page.evaluate(() => document.documentElement.dataset.vt ?? '')).toBe('');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});
