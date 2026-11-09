// The real popup (dist/) talking to the real service worker, no fake site and no network (docs/design.md
// 8.3 tests 18 and 19, popup and worker part): master password, lock, settings, rename, remove, wipe.
// Switching between two fake sites is card B6; here the browser only holds a plain c_user cookie.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const PASSWORD = 'orange cat naps by the canal';
const POPUP = (id: string) => `chrome-extension://${id}/popup/index.html`;

/** Fails the test on any request that leaves the extension, any dialog, and any error in a page. */
function watch(context: BrowserContext) {
  const problems: string[] = [];
  const guardPage = (page: Page) => {
    page.on('dialog', (d) => {
      problems.push(`dialog: ${d.type()} ${d.message()}`);
      void d.dismiss();
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  };
  context.on('page', guardPage);
  context.on('request', (r) => {
    const url = r.url();
    if (
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('blob:') &&
      !url.startsWith('data:')
    ) {
      problems.push(`request: ${url}`);
    }
  });
  return { problems };
}

async function open(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(POPUP(extensionId));
  return page;
}

const screen = (page: Page) => page.getByTestId('popup');

async function setUp(page: Page): Promise<void> {
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('setup-create').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
}

async function lockNow(page: Page): Promise<void> {
  await page.getByTestId('settings-btn').click();
  await page.getByTestId('lock-now').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'locked');
}

async function login(context: BrowserContext, user: string): Promise<void> {
  await context.addCookies([
    { name: 'c_user', value: user, domain: '.facebook.com', path: '/', secure: true },
    { name: 'xs', value: `session-${user}`, domain: '.facebook.com', path: '/', secure: true },
  ]);
}

test('first run asks for a master password, then lock, a wrong password and the right one', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');

  // the popup warns first, the worker is the real check
  await page.getByTestId('pw-input').fill('short');
  await page.getByTestId('setup-create').click();
  await expect(page.getByTestId('pw-hint')).toHaveText('Use at least 10 characters.');
  await page.getByTestId('pw-input').fill('0123456789');
  await page.getByTestId('setup-create').click();
  await expect(page.getByTestId('pw-hint')).toContainText('Avoid one repeated character');
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');

  await setUp(page);
  await lockNow(page);

  await page.getByTestId('pw-input').fill('not the password');
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('pw-hint')).toHaveText('Wrong password. Try again.');
  await expect(screen(page)).toHaveAttribute('data-state', 'locked');

  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  expect(problems).toEqual([]);
});

test('too many wrong passwords is said in words, not as a code', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  await lockNow(page);
  for (let i = 0; i < 6; i += 1) {
    await page.getByTestId('pw-input').fill(`wrong password ${i}`);
    await page.getByTestId('unlock').click();
    await expect(page.getByTestId('unlock')).toHaveAttribute('data-btn-state', 'err');
    await expect(page.getByTestId('unlock')).toHaveAttribute('data-btn-state', 'idle');
  }
  await expect(page.getByTestId('pw-hint')).toContainText('Too many wrong passwords');
  await expect(page.getByTestId('pw-hint')).not.toContainText('too_many_attempts');
  expect(problems).toEqual([]);
});

test('stopping the service worker does not ask for the password again', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);

  // stop the worker the way Chrome does when it is idle (CDP ServiceWorker.stopWorker), and wait until it is stopped
  const cdp = await context.newCDPSession(page);
  const status = new Map<string, string>();
  const seen: string[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
    for (const v of e.versions) {
      if (!v.scriptURL.includes(extensionId)) continue;
      status.set(v.versionId, v.runningStatus);
      seen.push(v.runningStatus);
    }
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => status.size).toBeGreaterThan(0);
  for (const versionId of status.keys()) await cdp.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => seen).toContain('stopped');

  const second = await open(context, extensionId);
  await expect(screen(second)).toHaveAttribute('data-state', 'empty'); // not "locked"
  await expect(second.getByTestId('pw-input')).toHaveCount(0);
  // the answer came from a worker that started again after it was stopped
  expect(seen.slice(seen.indexOf('stopped'))).toContain('running');
  expect(problems).toEqual([]);
});

test('theme and language are kept by the worker and come back in a new popup', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  await page.getByTestId('settings-btn').click();
  await page.getByTestId('s-theme-dark').click();
  await page.getByTestId('s-lang-th').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  // let the worker finish saving, then forget the popup's own cache so only the worker can answer
  await expect
    .poll(
      async () =>
        await open(context, extensionId).then(async (p) => {
          const t = await p.locator('html').getAttribute('data-theme');
          await p.close();
          return t;
        }),
    )
    .toBe('dark');
  await page.evaluate(() => localStorage.clear());
  await page.close();

  const second = await open(context, extensionId);
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(second.locator('html')).toHaveAttribute('lang', 'th');
  await expect(second.getByTestId('empty')).toContainText('ยังไม่มีบัญชี Facebook');
  expect(problems).toEqual([]);
});

test('add, rename and remove an account; a duplicate is explained', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  await login(context, '100012345678');
  const page = await open(context, extensionId);
  await setUp(page);

  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('add-form')).toContainText('5678');
  await page.getByTestId('add-input').fill('Shop page');
  await page.getByTestId('add-save').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'list');
  const row = page.locator('[data-testid^="row-"]');
  await expect(row).toContainText('Shop page');

  // the same login again: said in words, with no retry
  await page.getByTestId('add-account').click();
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('notice')).toContainText('already saved');
  await expect(page.getByTestId('notice-retry')).toHaveCount(0);
  await page.getByTestId('notice-close').click();
  await page.getByTestId('add-cancel').click();

  await page.locator('[data-testid^="rename-"]').click();
  await page.getByTestId('rename-input').fill('Main shop');
  await page.getByTestId('rename-save').click();
  await expect(row).toContainText('Main shop');

  // a new popup shows what the worker kept
  const again = await open(context, extensionId);
  await expect(again.locator('[data-testid^="row-"]')).toContainText('Main shop');
  await again.close();

  await page.locator('[data-testid^="delete-"]').click();
  await page.getByTestId('delete-confirm').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  const third = await open(context, extensionId);
  await expect(screen(third)).toHaveAttribute('data-state', 'empty');
  expect(problems).toEqual([]);
});

test('add while nobody is logged in shows the note', async ({ context, extensionId }) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('add-not-logged-in')).toBeVisible();
  expect(problems).toEqual([]);
});

test('wipe all data from Settings, and the forgot-password wipe, both return to setup', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  await login(context, '100012345678');
  const page = await open(context, extensionId);
  await setUp(page);
  await page.getByTestId('add-account').click();
  await page.getByTestId('add-save').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'list');

  await page.getByTestId('settings-btn').click();
  await page.getByTestId('s-wipe').click();
  await page.getByTestId('s-wipe-ok').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  const fresh = await open(context, extensionId);
  await expect(screen(fresh)).toHaveAttribute('data-state', 'setup');
  await fresh.close();

  await setUp(page);
  await lockNow(page);
  await page.getByTestId('forgot').click();
  await page.getByTestId('wipe-ok').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  expect(problems).toEqual([]);
});

test('a worker stuck on chrome.cookies.getAll: the popup says it timed out in time and works again', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  const worker = context.serviceWorkers().find((w) => w.url().includes(extensionId));
  if (!worker) throw new Error('no service worker');
  // the worker never gets an answer from the cookie store (the QC harness of t-556)
  await worker.evaluate(() => {
    const store = chrome.cookies as unknown as Record<string, unknown>;
    store.__getAll = store.getAll;
    store.getAll = () => new Promise(() => {});
  });

  const started = Date.now();
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('notice')).toBeVisible({ timeout: 9000 });
  expect(Date.now() - started).toBeLessThan(9000); // the read deadline is 5 s
  await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeout');
  await expect(page.getByTestId('notice')).toContainText("didn't answer in time");
  await expect(page.getByTestId('notice')).not.toContainText('timeout');

  // restore the worker: the popup is usable again, nothing was left disabled
  await worker.evaluate(() => {
    const store = chrome.cookies as unknown as Record<string, unknown>;
    store.getAll = store.__getAll;
  });
  await page.getByTestId('notice-close').click();
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('add-not-logged-in')).toBeVisible();
  expect(problems).toEqual([]);
});

/** The popup's messages reach the worker, but the answer to one kind never comes back (the QC harness of t-558). */
async function loseAnswers(page: Page, kind: string, doWork = true): Promise<void> {
  await page.evaluate(
    ([lostKind, work]) => {
      const w = window as unknown as {
        __hangReads: boolean;
        __sent: string[];
        chrome: { runtime: { sendMessage: (...a: unknown[]) => Promise<unknown> } };
      };
      w.__hangReads = false;
      w.__sent = [];
      const rt = w.chrome.runtime;
      const original = rt.sendMessage.bind(rt);
      rt.sendMessage = (m: unknown, ...rest: unknown[]) => {
        const type = (m as { type: string }).type;
        w.__sent.push(type);
        if (type === lostKind) {
          if (work) void original(m, ...rest); // the worker does the work (or never hears of it)
          w.__hangReads = true;
          return new Promise(() => {}); // the answer never arrives
        }
        if (
          type === 'state.get' &&
          w.__hangReads &&
          (window as unknown as { __hold?: boolean }).__hold
        )
          return new Promise(() => {});
        return original(m, ...rest);
      };
    },
    [kind, doWork] as const,
  );
}
const sentTypes = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);

test('setup done by the worker but its answer lost: the popup reads the state and leaves the setup page', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  await loseAnswers(page, 'vault.setup');
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('setup-create').click();
  // the real list is drawn (no password field), with the notice on top
  await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeout', {
    timeout: 20000,
  });
  await expect(page.getByTestId('pw-input')).toHaveCount(0);
  await expect(page.getByTestId('add-account')).toBeVisible();
  await expect(page.getByTestId('notice')).toContainText('The list now shows the current state.');
  const sent = await sentTypes(page);
  expect(sent.filter((t) => t === 'vault.setup')).toHaveLength(1);
  expect(sent.filter((t) => t === 'state.get')).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('unlock done by the worker but its answer lost: the popup reads the state and leaves the locked page', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  await lockNow(page);
  await loseAnswers(page, 'vault.unlock');
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  // the real list is drawn (no password field), with the notice on top
  await expect(page.getByTestId('notice')).toHaveAttribute('data-code', 'timeout', {
    timeout: 20000,
  });
  await expect(page.getByTestId('pw-input')).toHaveCount(0);
  await expect(page.getByTestId('add-account')).toBeVisible();
  await expect(page.getByTestId('notice')).toContainText('The list now shows the current state.');
  const sent = await sentTypes(page);
  expect(sent.filter((t) => t === 'vault.unlock')).toHaveLength(1);
  expect(sent.filter((t) => t === 'state.get')).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('the answer is lost and the state cannot be read either: stale notice, writes off, retry only reads', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  await lockNow(page);
  await loseAnswers(page, 'vault.unlock');
  await page.evaluate(() => {
    (window as unknown as { __hold: boolean }).__hold = true;
  });
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('pw-hint')).toContainText("current state couldn't be loaded", {
    timeout: 25000,
  });
  await expect(screen(page)).toHaveAttribute('data-state', 'locked');
  await expect(page.getByTestId('unlock')).toHaveCount(0); // no write button while the state is stale
  const before = await sentTypes(page);

  await page.evaluate(() => {
    (window as unknown as { __hold: boolean }).__hold = false;
  });
  await page.getByTestId('notice-retry').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty', { timeout: 10000 });
  const after = (await sentTypes(page)).slice(before.length);
  expect(after).toEqual(['state.get']);
  expect(problems).toEqual([]);
});

test('a password page that is still a password page after the reconcile: the words do not mention a list', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  await setUp(page);
  await lockNow(page);
  await loseAnswers(page, 'vault.unlock', false); // the worker never gets the unlock
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('pw-hint')).toHaveText(
    "The extension didn't answer in time. Try again.",
    { timeout: 20000 },
  );
  await expect(screen(page)).toHaveAttribute('data-state', 'locked');
  await expect(page.getByTestId('unlock')).toBeEnabled(); // not stale: the state was read
  expect(problems).toEqual([]);
});

test('the master password is never in the page markup: typing, redraws, sending (setup and unlock)', async ({
  context,
  extensionId,
}) => {
  const { problems } = watch(context);
  const page = await open(context, extensionId);
  const markup = () => page.evaluate(() => document.documentElement.outerHTML);
  const WRONG = 'a wrong password for the canal';

  await expect(screen(page)).toHaveAttribute('data-state', 'setup');
  await page.getByTestId('pw-input').fill(PASSWORD);
  expect(await markup()).not.toContain(PASSWORD);
  await page.getByTestId('pw-toggle').click(); // a redraw with the text shown
  await expect(page.getByTestId('pw-input')).toHaveValue(PASSWORD);
  expect(await markup()).not.toContain(PASSWORD);
  await page.getByTestId('setup-create').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  expect(await markup()).not.toContain(PASSWORD);

  await lockNow(page);
  await page.getByTestId('pw-input').fill(WRONG);
  expect(await markup()).not.toContain(WRONG);
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('unlock')).toHaveAttribute('data-btn-state', 'err');
  expect(await markup()).not.toContain(WRONG);
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('pw-toggle').click();
  expect(await markup()).not.toContain(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(screen(page)).toHaveAttribute('data-state', 'empty');
  expect(await markup()).not.toContain(PASSWORD);
  expect(problems).toEqual([]);
});
