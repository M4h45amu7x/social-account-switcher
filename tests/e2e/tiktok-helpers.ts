import { type BrowserContext, expect, type Page, type Worker } from '@playwright/test';
import type { SessionMap } from '../../src/lib/vault';
import { fakeTikTok, TT, TT_OTHER } from './fake-tiktok';
import { launchExtension } from './fixtures';
import { startHttpsSites } from './https-sites';
import { tiktokDist } from './tiktok-build';

export const PASSWORD = 'orange cat naps by the canal';
export type Answer = { ok: boolean; error?: string; value?: unknown };
export type TestHooks = {
  __tiktokTest: {
    writes: import('../../src/lib/ports').BrowserCookie[];
    clearWrites(): void;
    hold(): void;
    held: boolean;
    release(): void;
    saved(): Promise<SessionMap>;
    ready: Promise<unknown>;
  };
};
export const send = (page: Page, message: unknown) =>
  page.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<Answer>;
export const worker = async (context: BrowserContext): Promise<Worker> =>
  context.serviceWorkers()[0] ?? context.waitForEvent('serviceworker');
export async function launchTikTok(locale = 'en') {
  const fake = fakeTikTok();
  const sites = await startHttpsSites([TT, TT_OTHER], fake.handler);
  const launched = await launchExtension({ dir: tiktokDist, locale, extraArgs: sites.args }).catch(
    async (e) => {
      await sites.close();
      throw e;
    },
  );
  const { context } = launched;
  const external: string[] = [];
  const unexpected: string[] = [];
  context.on('request', (request) => {
    const url = request.url();
    if (
      !url.startsWith('chrome-extension:') &&
      ![TT, TT_OTHER].some((host) => url.startsWith(`https://${host}/`))
    )
      unexpected.push(url);
    if (request.serviceWorker() || request.frame().url().startsWith('chrome-extension:')) {
      if (!url.startsWith('chrome-extension:')) external.push(url);
    }
  });
  const dispose = async () => {
    try {
      await launched.close();
    } finally {
      await sites.close();
    }
  };
  try {
    const sw = await worker(context);
    const extensionId = new URL(sw.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    const tab = await context.newPage();
    await tab.goto(`https://${TT}/`);
    const tabId = await sw.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://www.tiktok.com/*' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Missing fixture tab');
    return {
      fake,
      sites,
      context,
      sw,
      popup,
      tab,
      tabId,
      extensionId,
      close: async () => {
        await dispose();
        expect(external, 'independent extension network requests').toEqual([]);
        expect(unexpected, 'requests outside the local fixture hosts').toEqual([]);
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof launchTikTok>>;
export async function login(h: Harness, user: string) {
  await h.tab.bringToFront();
  await h.tab.goto(`https://${TT}/__e2e/login?user=${user}`);
}
export async function add(h: Harness, user: string) {
  await login(h, user);
  const answer = await send(h.popup, {
    type: 'account.addCurrent',
    platform: 'tiktok',
    label: user,
    tabId: h.tabId,
  });
  if (!answer.ok) throw new Error(`Add ${user}: ${answer.error}`);
  return (answer.value as { id: string }).id;
}
export const saved = (sw: Worker) =>
  sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.saved());
export const cookies = (sw: Worker) =>
  sw.evaluate(() => chrome.cookies.getAll({ domain: 'tiktok.com', partitionKey: {} }));
export const tokenOf = (list: { name: string; value: string }[]) =>
  list.find((c) => c.name === 'sessionid')?.value ?? '';
export async function setupPair(h: Harness) {
  await send(h.popup, { type: 'vault.setup', password: PASSWORD });
  const alice = await add(h, 'alice');
  const bob = await add(h, 'bob');
  return { alice, bob };
}
