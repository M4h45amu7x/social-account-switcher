// Shared by the popup specs: builds the extension plus the e2e page (src/popup/e2e) once per run and
// gives helpers to open a sample state. See tests/e2e/vite.e2e.config.ts.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { makeTest } from './fixtures';

export const root = resolve(import.meta.dirname, '..', '..');
export const outDir = resolve(root, 'test-results', 'popup-dist');
export const popupTest = makeTest(outDir);

let built = false;
export function buildPopup(): void {
  if (built) return;
  execFileSync(
    'bunx',
    ['vite', 'build', '--config', 'tests/e2e/vite.e2e.config.ts', '--logLevel', 'error'],
    { cwd: root, stdio: 'pipe' },
  );
  built = true;
}

export const idle = (page: Page) =>
  page.waitForFunction(() => !document.documentElement.dataset.vtBusy, null, { timeout: 8000 });

export async function open(page: Page, id: string, q: Record<string, string>) {
  await page.goto(`chrome-extension://${id}/popup/e2e/e2e.html?${new URLSearchParams(q)}`);
  await page.waitForSelector('html[data-e2e-ready="1"]');
  await idle(page);
}
