import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

test('extension loads unpacked: service worker starts and popup renders without errors', async ({
  context,
  extensionId,
}) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);

  const problems: string[] = [];
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith('chrome-extension://')) problems.push(`network: ${r.url()}`);
  });

  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  // nothing is stored yet, so the real popup asks for a master password first
  const heading = await page.evaluate(() => chrome.i18n.getMessage('app_title'));
  expect(heading).not.toBe('');
  await expect(page.locator('h1')).toHaveText(heading);
  expect(await page.title()).toBe(await page.evaluate(() => chrome.i18n.getMessage('popupTitle')));
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'setup');
  await expect(page.getByTestId('setup')).toBeVisible();

  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);

  expect(problems).toEqual([]);
});

test.describe('Thai UI', () => {
  test.use({ locale: 'th-TH' });

  test('popup uses _locales/th when the browser language is Thai', async ({
    context,
    extensionId,
  }) => {
    const th = JSON.parse(
      readFileSync(new URL('../../public/_locales/th/messages.json', import.meta.url), 'utf8'),
    ) as Record<string, { message: string }>;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(page.locator('h1')).toHaveText(th.app_title?.message ?? '');
    await expect(page.getByTestId('setup')).toContainText('ตั้งรหัสผ่านหลัก');
    expect(await page.evaluate(() => document.documentElement.lang)).toMatch(/^th/);
  });
});
