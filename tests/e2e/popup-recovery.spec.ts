// Independent t-556 fault tests. Product dist is unchanged; faults target browser APIs at runtime.
import type { BrowserContext, Dialog, Page, Request, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

type Hooks = {
  __qcSend: (m: { type: string }) => Promise<{ ok: boolean; value?: unknown }>;
  __qcRequests: string[];
  __qcRelease: (() => void)[];
  __qcReplies: { type: string; value: { ok: boolean } }[];
  __qcHold: boolean;
  __qcRead: number;
  __qcHeld: number;
  __qcGetAll: unknown;
};
type Msg = { type: string };

const PASSWORD = 'orange cat naps by the canal';
const screen = (p: Page) => p.getByTestId('popup');

async function ready(context: BrowserContext, extensionId: string) {
  const page = await context.newPage();
  const worker = context.serviceWorkers()[0] as Worker;
  const external: string[] = [],
    dialogs: string[] = [];
  context.on('request', (r: Request) => {
    if (!/^(chrome-extension:|data:|blob:)/.test(r.url())) external.push(r.url());
  });
  page.on('dialog', async (d: Dialog) => {
    dialogs.push(d.message());
    await d.dismiss();
  });
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('setup-create').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  for (const user of ['1000000001111', '1000000002222']) {
    await context.addCookies([
      { name: 'c_user', value: user, domain: '.facebook.com', path: '/', secure: true },
      { name: 'xs', value: `synthetic-${user}`, domain: '.facebook.com', path: '/', secure: true },
    ]);
    await page.getByTestId('add-account').click();
    await expect(page.getByTestId('add-form')).toBeVisible();
    await page.getByTestId('add-save').click();
    await expect(screen(page)).toHaveAttribute('data-state', 'list');
  }
  const id = await page.locator('button[data-act="switch"]').last().getAttribute('data-id');
  return { page, worker, external, dialogs, id };
}

test('write and reconcile timeout: retry is read-only and late answers are ignored', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(35000);
  const { page, worker } = await ready(context, extensionId);
  await worker.evaluate(() => {
    (globalThis as unknown as Hooks).__qcRequests = [];
    chrome.runtime.onMessage.addListener((m) => {
      (globalThis as unknown as Hooks).__qcRequests.push(m.type);
    });
  });
  await page.evaluate(() => {
    const w = globalThis as unknown as Hooks;
    w.__qcSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    w.__qcRead = 0;
    w.__qcRelease = [];
    chrome.runtime.sendMessage = ((m: Msg) => {
      const work = w.__qcSend(m);
      if (m.type === 'account.rename' || (m.type === 'state.get' && ++w.__qcRead === 1))
        return work.then(
          (value: unknown) => new Promise((resolve) => w.__qcRelease.push(() => resolve(value))),
        );
      return work;
    }) as unknown as typeof chrome.runtime.sendMessage;
  });
  await page.locator('[data-testid^="rename-"]').first().click();
  await page.getByTestId('rename-input').fill('QC renamed');
  const started = Date.now();
  await page.getByTestId('rename-save').click();
  await expect(page.getByTestId('notice-retry')).toBeVisible({ timeout: 18000 });
  const elapsed = Date.now() - started;
  await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeoutStale');
  expect(elapsed).toBeGreaterThanOrEqual(14500);
  expect(elapsed).toBeLessThan(18000);
  await expect(page.getByTestId('add-account')).toBeDisabled();
  const before = await worker.evaluate(() => (globalThis as unknown as Hooks).__qcRequests);
  expect(before).toEqual(['account.rename', 'state.get']);
  await page.getByTestId('notice-retry').click();
  await expect(page.getByTestId('notice')).toHaveCount(0);
  await expect(page.locator('[data-testid^="row-"]').first()).toContainText('QC renamed');
  const stateBefore = await page.evaluate(() =>
    JSON.stringify({
      screen: document.querySelector('[data-testid="popup"]')?.getAttribute('data-state'),
      text: document.body.textContent,
      rows: [...document.querySelectorAll('[data-testid^="row-"]')].map((e) => ({
        id: e.getAttribute('data-id'),
        active: e.classList.contains('active'),
      })),
      buttons: [...document.querySelectorAll('button')].map((e) => ({
        testid: e.dataset.testid,
        disabled: e.disabled,
      })),
    }),
  );
  await page.evaluate(() => {
    for (const release of (globalThis as unknown as Hooks).__qcRelease) release();
  });
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        screen: document.querySelector('[data-testid="popup"]')?.getAttribute('data-state'),
        text: document.body.textContent,
        rows: [...document.querySelectorAll('[data-testid^="row-"]')].map((e) => ({
          id: e.getAttribute('data-id'),
          active: e.classList.contains('active'),
        })),
        buttons: [...document.querySelectorAll('button')].map((e) => ({
          testid: e.dataset.testid,
          disabled: e.disabled,
        })),
      }),
    ),
  ).toBe(stateBefore);
  const after = await worker.evaluate(() => (globalThis as unknown as Hooks).__qcRequests);
  expect(after).toEqual(['account.rename', 'state.get', 'state.get']);
});
