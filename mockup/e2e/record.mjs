// Records the three showcase GIFs for mockup/popup.html: theme switch (Circle Reveal), switch account, delete account.
// Needs: playwright (PLAYWRIGHT_MODULE), ffmpeg on PATH. Optional: CHROMIUM_PATH.
// Output: mockup/media/{theme-switch,switch-account,delete-account}.gif
// The motion tokens are slowed down (--motion-scale) so the animation is readable at 15 fps.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mockupDir = resolve(here, '..');
const mediaDir = join(mockupDir, 'media');
const htmlPath = join(mockupDir, 'popup.html');
mkdirSync(mediaDir, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.error('Cannot find playwright. Set PLAYWRIGHT_MODULE=<path>/node_modules/playwright');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'sam-rec-'));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function record(name, scenario, { lang = 'en', scale = 2.2 } = {}) {
  const dir = join(tmp, name);
  const context = await browser.newContext({
    viewport: { width: 760, height: 640 },
    colorScheme: 'light',
    locale: lang === 'th' ? 'th-TH' : 'en-US',
    recordVideo: { dir, size: { width: 760, height: 640 } },
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(htmlPath).href);
  await page.addStyleTag({ content: `:root{--motion-scale:${scale}}` });
  const idle = () => page.waitForFunction(() => !document.documentElement.dataset.vtBusy, null, { timeout: 8000 });
  const state = (s) => page.waitForFunction((v) => document.getElementById('popup').dataset.state === v, s, { timeout: 12000 });
  await page.waitForTimeout(700);
  const marker = Date.now();
  await scenario({ page, idle, state, tid: (id) => page.getByTestId(id) });
  await page.waitForTimeout(900);
  const trimStart = (marker - Date.now()) * 0; // keep the first 0.4 s of the idle page as context
  await context.close();                          // flushes the video
  const webm = join(dir, readdirSync(dir).find((f) => f.endsWith('.webm')));
  const out = join(mediaDir, `${name}.gif`);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-ss', String(0.4 + trimStart), '-i', webm,
    '-vf', 'fps=15,scale=560:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0', out,
  ]);
  console.log('wrote', out);
}

try {
  await record('theme-switch', async ({ tid, idle, state, page }) => {
    await tid('settings-btn').click(); await state('settings'); await idle(); await page.waitForTimeout(500);
    await tid('s-theme-dark').click(); await idle(); await page.waitForTimeout(900);
    await tid('s-theme-light').click(); await idle(); await page.waitForTimeout(700);
  });
  await record('switch-account', async ({ tid, idle, state, page }) => {
    await tid('tab-youtube').click(); await idle(); await page.waitForTimeout(600);
    await tid('tab-facebook').click(); await idle(); await page.waitForTimeout(600);
    await tid('row-fb2').locator('button.main').click();
    await state('success'); await page.waitForTimeout(2600);
  });
  await record('delete-account', async ({ tid, idle, state, page }) => {
    await tid('delete-fb3').click(); await state('delete'); await idle(); await page.waitForTimeout(900);
    await tid('delete-confirm').click(); await state('list'); await idle(); await page.waitForTimeout(900);
    await tid('add-account').click(); await state('adding'); await idle(); await page.waitForTimeout(500);
    await tid('add-save').click(); await state('list'); await idle(); await page.waitForTimeout(700);
  });
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
