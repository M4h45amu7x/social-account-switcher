// Loads dist/ as an unpacked extension in Playwright's Chromium (docs/design.md §9.6).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, test as base, chromium } from '@playwright/test';

const dist = resolve(import.meta.dirname, '..', '..', 'dist');

/** A test object that loads the unpacked extension in `dir` (dist/ by default). */
export const makeTest = (dir: string) =>
  base.extend<{ context: BrowserContext; extensionId: string }>({
    context: async ({ locale }, use) => {
      const profile = mkdtempSync(join(tmpdir(), 'sas-e2e-'));
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        // chrome.i18n follows the browser UI language, which on Linux comes from --lang / LANGUAGE,
        // not from Playwright's `locale` (that only sets navigator.language and Accept-Language).
        ...(locale
          ? { locale, env: { ...process.env, LANGUAGE: locale.split('-')[0] ?? locale } }
          : {}),
        args: [
          `--disable-extensions-except=${dir}`,
          `--load-extension=${dir}`,
          ...(locale ? [`--lang=${locale}`] : []),
        ],
      });
      await use(context);
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
    extensionId: async ({ context }, use) => {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      await use(new URL(worker.url()).host);
    },
  });

export const test = makeTest(dist);
export const expect = test.expect;
