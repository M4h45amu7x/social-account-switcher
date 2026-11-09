// Independent t-556 fault tests. Product dist is unchanged; faults target browser APIs at runtime.
import type { Page, Worker } from '@playwright/test';
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

for (const kind of ['setup', 'unlock'])
  test(`${kind} committed with lost answer reconciles actual page`, async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(25000);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(screen(page)).toHaveAttribute('data-state', 'setup');
    if (kind === 'unlock') {
      await page.getByTestId('pw-input').fill(PASSWORD);
      await page.getByTestId('setup-create').click();
      await expect(screen(page)).toHaveAttribute('data-state', 'empty');
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'vault.lock' }));
      await page.reload();
      await expect(screen(page)).toHaveAttribute('data-state', 'locked');
    }
    const worker = context.serviceWorkers()[0] as Worker;
    await worker.evaluate(() => {
      (globalThis as unknown as Hooks).__qcRequests = [];
      chrome.runtime.onMessage.addListener((m) =>
        (globalThis as unknown as Hooks).__qcRequests.push(m.type),
      );
    });
    await page.evaluate((kind) => {
      const w = globalThis as unknown as Hooks;
      w.__qcSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      w.__qcRequests = [];
      chrome.runtime.sendMessage = ((m: Msg) => {
        w.__qcRequests.push(m.type);
        const work = w.__qcSend(m);
        return m.type === `vault.${kind}` ? work.then(() => new Promise(() => {})) : work;
      }) as unknown as typeof chrome.runtime.sendMessage;
    }, kind);
    await page.getByTestId('pw-input').fill(PASSWORD);
    await page.getByTestId(kind === 'setup' ? 'setup-create' : 'unlock').click();
    await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeout', {
      timeout: 13000,
    });
    const observation = await page.evaluate(async () => {
      const w = globalThis as unknown as Hooks;
      return {
        requests: w.__qcRequests,
        actual: await w.__qcSend({ type: 'state.get' }),
        page: document.querySelector('[data-testid="popup"]')?.getAttribute('data-state'),
        hint: document.querySelector('[data-testid="pw-hint"]')?.textContent,
      };
    });
    const workerRequests = await worker.evaluate(
      () => (globalThis as unknown as Hooks).__qcRequests,
    );
    expect(workerRequests.filter((s: string) => s === `vault.${kind}`)).toHaveLength(1);
    expect(observation.requests).toEqual([`vault.${kind}`, 'state.get']);

    expect(observation.actual.value).toMatchObject({ hasVault: true, locked: false });
    expect(observation.requests.filter((s: string) => s === 'state.get')).toHaveLength(1);
    await expect(page.getByTestId('pw-input')).toHaveCount(0);
    await expect(page.getByTestId('add-account')).toBeVisible();
  });

async function hold(page: Page, type: string, commit: boolean) {
  await page.evaluate(
    ({ type, commit }) => {
      const w = globalThis as unknown as Hooks;
      w.__qcSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      w.__qcRequests = [];
      w.__qcHold = false;
      w.__qcRelease = [];
      w.__qcReplies = [];
      chrome.runtime.sendMessage = ((m: Msg) => {
        w.__qcRequests.push(m.type);
        if (m.type === type) {
          w.__qcHold = true;
          const work = commit ? w.__qcSend(m) : Promise.resolve({ ok: false, error: 'locked' });
          return work.then((v: unknown) => new Promise((res) => w.__qcRelease.push(() => res(v))));
        }
        if (m.type === 'state.get' && w.__qcHold)
          return w
            .__qcSend(m)
            .then((v: unknown) => new Promise((res) => w.__qcRelease.push(() => res(v))));
        return w.__qcSend(m).then(async (value: unknown) => {
          if (m.type === 'state.get') await new Promise((r) => setTimeout(r, 1000));
          w.__qcReplies.push({ type: m.type, value: value as { ok: boolean } });
          return value;
        });
      }) as unknown as typeof chrome.runtime.sendMessage;
    },
    { type, commit },
  );
}
async function seed(page: Page, extensionId: string, kind: string) {
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  if (kind === 'setup') return;
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('setup-create').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  if (kind === 'locked') {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'vault.lock' }));
    await page.reload();
    await expect(screen(page)).toHaveAttribute('data-state', 'locked');
  }
  if (kind === 'settings') await page.getByTestId('settings-btn').click();
}
for (const kind of ['setup', 'locked', 'settings'])
  test(`stale same-state recovery ${kind}`, async ({ context, extensionId }) => {
    test.setTimeout(30000);
    const page = await context.newPage();
    await seed(page, extensionId, kind);
    const req =
      kind === 'setup' ? 'vault.setup' : kind === 'locked' ? 'vault.unlock' : 'settings.set';
    await hold(page, req, kind === 'settings');
    if (kind === 'settings') await page.getByTestId('s-theme-dark').click();
    else {
      await page.getByTestId('pw-input').fill(PASSWORD);
      await page.getByTestId(kind === 'setup' ? 'setup-create' : 'unlock').click();
    }
    if (kind === 'settings')
      await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeoutStale', {
        timeout: 18000,
      });
    else
      await expect(page.getByTestId('pw-hint')).toContainText("current state couldn't be loaded", {
        timeout: 18000,
      });

    const before = await page.evaluate(() => (globalThis as unknown as Hooks).__qcRequests);
    expect(before).toEqual([req, 'state.get']);
    await page.evaluate(() => {
      (globalThis as unknown as Hooks).__qcHold = false;
    });
    await page.getByTestId('notice-retry').click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as Hooks).__qcRequests.length))
      .toBe(3);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (globalThis as unknown as Hooks).__qcReplies.some(
            (x: Hooks['__qcReplies'][number]) => x.type === 'state.get' && x.value.ok,
          ),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(700);
    const observation = await page.evaluate(() => ({
      requests: (globalThis as unknown as Hooks).__qcRequests,
      replies: (globalThis as unknown as Hooks).__qcReplies,
      screen: document.querySelector('[data-testid="popup"]')?.getAttribute('data-state'),
      text: document.body.textContent,
      buttons: [...document.querySelectorAll('button')].map((e) => ({
        id: e.dataset.testid,
        disabled: e.disabled,
      })),
    }));

    expect(observation.requests).toEqual([req, 'state.get', 'state.get']);
    if (kind === 'settings')
      await expect(page.getByTestId('lock-now')).toBeEnabled({ timeout: 1000 });
    else
      await expect(page.getByTestId(kind === 'setup' ? 'setup-create' : 'unlock')).toBeVisible({
        timeout: 1000,
      });
  });
for (const kind of ['setup', 'main'])
  test(`stale Escape retains retry ${kind}`, async ({ context, extensionId }) => {
    test.setTimeout(30000);
    const page = await context.newPage();
    await seed(page, extensionId, kind);
    const req = kind === 'setup' ? 'vault.setup' : 'account.probe';
    await hold(page, req, false);
    if (kind === 'setup') {
      await page.getByTestId('pw-input').fill(PASSWORD);
      await page.getByTestId('setup-create').click();
      await expect(page.getByTestId('pw-hint')).toContainText("current state couldn't be loaded", {
        timeout: 18000,
      });
    } else {
      await page.getByTestId('add-account').click();
      await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeoutStale', {
        timeout: 13000,
      });
    }
    const before = await page.evaluate(() => (globalThis as unknown as Hooks).__qcRequests.length);
    await page.getByTestId('notice-retry').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const visible = await page.getByTestId('notice-retry').count();
    if (visible) await page.getByTestId('notice-retry').click();
    await page.waitForTimeout(300);
    const observation = await page.evaluate(() => ({
      requests: (globalThis as unknown as Hooks).__qcRequests,
      replies: (globalThis as unknown as Hooks).__qcReplies,
      screen: document.querySelector('[data-testid="popup"]')?.getAttribute('data-state'),
      text: document.body.textContent,
    }));
    expect(visible).toBe(1);
    expect(observation.requests).toHaveLength(before + 1);
  });

for (const kind of ['setup', 'locked'])
  test(`caret during delayed same-state retry ${kind}`, async ({ context, extensionId }) => {
    test.setTimeout(30000);
    const page = await context.newPage();
    await seed(page, extensionId, kind);
    await hold(page, kind === 'setup' ? 'vault.setup' : 'vault.unlock', false);
    await page.getByTestId('pw-input').fill(PASSWORD);
    await page.getByTestId(kind === 'setup' ? 'setup-create' : 'unlock').click();
    await expect(page.getByTestId('pw-hint')).toContainText("current state couldn't be loaded", {
      timeout: 18000,
    });
    await page.evaluate(() => {
      (globalThis as unknown as Hooks).__qcHold = false;
    });
    await page.getByTestId('notice-retry').click();
    await page.waitForTimeout(400);
    await page.getByTestId('pw-input').fill('abcdefghi');
    await page.getByTestId('pw-input').evaluate((input: HTMLInputElement) => {
      input.focus();
      input.setSelectionRange(3, 3);
    });
    await expect(page.getByTestId('notice-retry')).toHaveCount(1);
    const before = await page.getByTestId('pw-input').evaluate((input: HTMLInputElement) => ({
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      focused: document.activeElement === input,
    }));
    await expect(page.getByTestId('notice-retry')).toHaveCount(0);
    await page.waitForTimeout(100);
    const after = await page.getByTestId('pw-input').evaluate((input: HTMLInputElement) => ({
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      focused: document.activeElement === input,
    }));
    await page.keyboard.type('X');
    const typed = await page.getByTestId('pw-input').inputValue();

    expect(after).toEqual(before);
    expect(typed).toBe('abcXdefghi');
  });
