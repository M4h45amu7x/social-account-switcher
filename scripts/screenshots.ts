// README illustrations from the real popup renderer with fictional accounts, never a live login.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'docs/images');
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'sas-readme-'));
const dist = join(temp, 'extension');
let context: BrowserContext | undefined;
try {
  execFileSync(
    'bunx',
    [
      '--no-install',
      'vite',
      'build',
      '--config',
      'tests/e2e/vite.e2e.config.ts',
      '--outDir',
      dist,
      '--logLevel',
      'error',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium',
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  await context.route(/^https?:/, (route) => route.abort());
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 800 });
  for (const [state, theme, name] of [
    ['list', 'light', 'popup'],
    ['locked', 'dark', 'locked'],
  ]) {
    const params = new URLSearchParams({
      state: state ?? 'list',
      theme: theme ?? 'light',
      lang: 'en',
      ui: 'en-US',
    });
    await page.goto(`chrome-extension://${id}/popup/e2e/e2e.html?${params}`);
    await page.waitForSelector('html[data-e2e-ready="1"]');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      // Omit the generic encryption footer: labels and YouTube metadata are plaintext.
      document.querySelector('footer.foot')?.remove();
      document.querySelector<HTMLInputElement>('input')?.blur();
    });
    await page
      .locator('#app')
      .screenshot({ path: resolve(out, `${name}.png`), animations: 'disabled' });
  }
} finally {
  try {
    await context?.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const bytes =
  (await stat(resolve(out, 'popup.png'))).size + (await stat(resolve(out, 'locked.png'))).size;
if (bytes >= 200_000) throw new Error(`README screenshots exceed 200 KB: ${bytes}`);
console.log(`screenshots: 2 sample popup PNGs, ${bytes} bytes (<200 KB)`);
