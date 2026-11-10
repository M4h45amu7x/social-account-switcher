import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EXTRA_STATES, SAMPLE_STATES } from '../../src/popup/samples';
import { launchExtension } from './fixtures';
import { buildPopup, idle, open, outDir, root, popupTest as test } from './popup-build';

const { expect } = test;
test.beforeAll(buildPopup);

for (const lang of ['en', 'th']) {
  for (const theme of ['light', 'dark']) {
    test(`installed version: ${lang} ${theme}, every footer and Settings at 360px with DejaVu`, async ({
      page,
      extensionId,
    }) => {
      test.setTimeout(90_000);
      const manifest = JSON.parse(await readFile(resolve(outDir, 'manifest.json'), 'utf8'));
      for (const state of [...SAMPLE_STATES, ...EXTRA_STATES]) {
        await page.setViewportSize({ width: 360, height: 800 });
        await open(page, extensionId, { state, lang, theme, hold: '1' });
        await page.evaluate(async () => {
          const font = new FontFace('VersionWide', 'local("DejaVu Sans")');
          document.fonts.add(await font.load());
        });
        await page.addStyleTag({
          content: 'body, body * { font-family: VersionWide, sans-serif !important; }',
        });
        const badge = page.getByTestId('footer-version');
        await expect(badge).toHaveText(`v${manifest.version}`);
        await expect(badge).toHaveAccessibleName(
          new RegExp(manifest.version.replaceAll('.', '\\.')),
        );
        if (state === 'settings' || state === 'settings-wipe')
          await expect(page.getByTestId('settings-version')).toHaveText(`v${manifest.version}`);
        expect(
          await page.locator('footer').evaluate((footer) => {
            const badge = footer.querySelector('[data-testid="footer-version"]')!;
            const text = footer.querySelector('.foot-copy')!;
            const b = badge.getBoundingClientRect();
            const t = text.getBoundingClientRect();
            const f = footer.getBoundingClientRect();
            return (
              b.right <= f.right &&
              b.left >= t.right &&
              Math.abs(b.y + b.height / 2 - t.y - t.height / 2) < 2 &&
              footer.scrollWidth <= footer.clientWidth &&
              document.documentElement.scrollWidth <= 360
            );
          }),
        ).toBe(true);
        if (['list', 'settings', 'locked', 'setup'].includes(state)) {
          await idle(page);
          await page.screenshot({
            path: test.info().outputPath(`${state}-${lang}-${theme}.png`),
            animations: 'disabled',
          });
        }
      }
    });
  }
}

test('production popup reads installed getManifest version, including a different manifest build', async () => {
  test.setTimeout(60_000);
  const dir = resolve(root, 'test-results/version-dist');
  await mkdir(dir, { recursive: true });
  try {
    await cp(resolve(root, 'dist'), dir, { recursive: true });
    const path = resolve(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.version = '9.8.7.3';
    await writeFile(path, JSON.stringify(manifest));
    const { context, close } = await launchExtension({ dir });
    try {
      await context.route(/^https?:/, (route) => route.abort());
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup/index.html`);
      await expect(page.getByTestId('footer-version')).toHaveText(`v${manifest.version}`);
      const runtimeVersion = await page.evaluate(() => chrome.runtime.getManifest().version);
      expect(runtimeVersion).toBe(manifest.version);
      await page.getByTestId('pw-input').fill('fictional version test password');
      await page.getByTestId('setup-create').click();
      await expect(page.getByTestId('empty')).toBeVisible();
      await page.getByTestId('settings-btn').click();
      await expect(page.getByTestId('settings-version')).toHaveText(`v${runtimeVersion}`);
      await page.getByTestId('lock-now').click();
      await expect(page.getByTestId('locked')).toBeVisible();
      await expect(page.getByTestId('footer-version')).toHaveText(`v${runtimeVersion}`);
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
