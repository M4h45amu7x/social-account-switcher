// v0.1.1: the popup opens on the tab of the site the person is looking at (src/popup/start.ts), in real
// Chromium against the fake sites. Two ways in:
// - the real toolbar popup (chrome.action.openPopup), read through a DevTools port because Playwright
//   does not hand out extension popups as pages;
// - the same popup page opened in a background tab, so the site's tab stays the active tab of the window
//   (what tabs.query({ active, currentWindow }) answers in the toolbar popup) and Playwright can click it.
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import en from '../../public/_locales/en/messages.json' with { type: 'json' };
import th from '../../public/_locales/th/messages.json' with { type: 'json' };
import { FB, fakeSocial, IG, OTHER, SOCIAL_HOSTS } from './fake-social';
import { expect, launchExtension, test } from './fixtures';
import { type HttpsSites, type SiteHandler, startHttpsSites } from './https-sites';

const YT = 'www.youtube.com';
const locale = process.env.E2E_LOCALE === 'th' ? 'th' : 'en';
const messages = locale === 'th' ? th : en;
const PASSWORD = 'orange cat naps by the canal';
const shots =
  process.env.E2E_SHOTS ?? resolve(import.meta.dirname, '..', '..', 'test-results', 'open-on-site');

let context: BrowserContext;
let sites: HttpsSites;
let sw: Worker;
let extensionId = '';
let devtools = 0;
let closeBrowser: () => Promise<void>;
const social = fakeSocial();
const tabs = {} as Record<'facebook' | 'youtube' | 'other', Page>;

/** A YouTube with nobody logged in, next to the fake Facebook and Instagram. */
const handler: SiteHandler = (req, res, url) => {
  if (url.hostname !== YT) return social.handler(req, res, url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8"><title>YouTube</title><h1 id="who">YouTube</h1>');
};

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  sites = await startHttpsSites([...SOCIAL_HOSTS, YT], handler);
  devtools = await freePort();
  const launched = await launchExtension({
    locale,
    extraArgs: [...sites.args, `--remote-debugging-port=${devtools}`],
  });
  context = launched.context;
  closeBrowser = launched.close;
  // Records every platform the popup root shows and every view transition, from before its first script.
  await context.addInitScript(() => {
    if (!location.pathname.endsWith('/popup/index.html')) return;
    const seen = { platforms: [] as string[], vt: [] as string[] };
    Object.assign(globalThis, { opening: seen });
    new MutationObserver(() => {
      const app = document.getElementById('app');
      const p = app?.dataset.platform;
      if (p && seen.platforms.at(-1) !== p) seen.platforms.push(p);
      const vt = document.documentElement.dataset.vt;
      if (vt && seen.vt.at(-1) !== vt) seen.vt.push(vt);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
  for (const [name, url] of [
    ['facebook', `https://${FB}/`],
    ['youtube', `https://${YT}/watch?v=abc`],
    ['other', `https://${OTHER}/today`],
  ] as const) {
    tabs[name] = await context.newPage();
    await tabs[name].goto(url);
  }
});

test.afterAll(async () => {
  await closeBrowser?.();
  await sites?.close();
});

/** The popup page in a background tab of the same window: `site` stays the window's active tab. */
async function popupOver(site: Page): Promise<Page> {
  await site.bringToFront();
  const opened = context.waitForEvent('page');
  await sw.evaluate(
    (url) => chrome.tabs.create({ url, active: false }).then(() => undefined),
    `chrome-extension://${extensionId}/popup/index.html`,
  );
  const page = await opened;
  await expect(page.getByTestId('popup')).not.toHaveAttribute('data-state', 'loading');
  return page;
}

type Target = { id: string; url: string; webSocketDebuggerUrl: string };
const popupTargets = async (): Promise<Target[]> =>
  ((await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()) as Target[]).filter(
    (t) => t.url === `chrome-extension://${extensionId}/popup/index.html`,
  );

/** Polls `get` until it returns something, failing with `what` after `ms`. */
async function until<T>(get: () => Promise<T | undefined>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Which platform the real toolbar popup opened on, over `site`. Closes it after. */
async function realPopupOver(site: Page): Promise<string> {
  // a popup from before must be fully gone, or its closing target could be picked up below
  await until(async () => ((await popupTargets()).length === 0 ? true : undefined), 'no popup');
  await site.bringToFront();
  await sw.evaluate(() => chrome.action.openPopup());
  const target = await until(async () => (await popupTargets())[0], 'the toolbar popup');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await until(
    async () => (ws.readyState === WebSocket.OPEN ? true : undefined),
    'the DevTools socket',
  );
  const ask = (id: number, expression: string) =>
    until(
      () =>
        new Promise<{ v: unknown } | undefined>((done) => {
          const on = (m: MessageEvent) => {
            const msg = JSON.parse(String(m.data)) as {
              id?: number;
              result?: { result?: { value?: unknown } };
            };
            if (msg.id !== id) return;
            ws.removeEventListener('message', on);
            done({ v: msg.result?.result?.value });
          };
          ws.addEventListener('message', on);
          ws.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true },
            }),
          );
          setTimeout(() => {
            ws.removeEventListener('message', on);
            done(undefined);
          }, 2000);
        }),
      `popup answer ${id}`,
    );
  // the worker has answered (the platform itself is set before the first draw)
  const platform = (
    await ask(
      1,
      `(() => { const a = document.getElementById('app');
      return a && a.dataset.state && a.dataset.state !== 'loading' ? a.dataset.platform : null; })()`,
    )
  ).v;
  let answer = platform;
  for (let i = 2; answer === null && i < 200; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    answer = (
      await ask(
        i,
        `(() => { const a = document.getElementById('app');
      return a && a.dataset.state && a.dataset.state !== 'loading' ? a.dataset.platform : null; })()`,
      )
    ).v;
  }
  ws.send(
    JSON.stringify({
      id: 999,
      method: 'Runtime.evaluate',
      params: { expression: 'window.close()' },
    }),
  );
  ws.close();
  return String(answer);
}

const opening = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { opening: { platforms: string[]; vt: string[] } }).opening,
  );

async function shoot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.bringToFront();
  await page.setViewportSize({ width: 360, height: 640 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    expect(await page.locator('html').getAttribute('lang')).toBe(locale);
    const overflow = await page.evaluate(() => {
      const app = document.getElementById('app');
      if (!app) return ['missing app'];
      const box = app.getBoundingClientRect();
      return [...app.querySelectorAll<HTMLElement>('*')].flatMap((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return [];
        // The platform badge extends 3px beyond the avatar; visible overflow also
        // contributes to ancestor scroll sizes. Check their child text boxes instead.
        const decorated = el.matches('.avatar') || el.querySelector('.avatar') !== null;
        return r.right > box.right + 1 ||
          r.left < box.left - 1 ||
          (!decorated && el.scrollWidth > el.clientWidth + 1) ||
          (!decorated && el.scrollHeight > el.clientHeight + 1)
          ? [
              `${el.tagName}.${el.className} bounds=${r.left},${r.right}; client=${el.clientWidth}x${el.clientHeight}; scroll=${el.scrollWidth}x${el.scrollHeight}`,
            ]
          : [];
      });
    });
    expect(overflow).toEqual([]);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`), fullPage: true });
  }
}

test('setup: a master password, no accounts yet', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'setup');
  await page.getByTestId('pw-input').fill(PASSWORD);
  await page.getByTestId('setup-create').click();
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'empty');
  await page.close();
});

test('over YouTube: the popup opens on YouTube, with no slide from Facebook', async () => {
  expect(await realPopupOver(tabs.youtube)).toBe('youtube');

  const page = await popupOver(tabs.youtube);
  // what Chrome tells the popup about the tab under it
  const under = await page.evaluate(() =>
    chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0]?.url),
  );
  expect(under).toBe(`https://${YT}/watch?v=abc`);
  await expect(page.getByTestId('popup')).toHaveAttribute('data-platform', 'youtube');
  // one platform from the first draw on, and never the tab slide (the loading → list fade is fine)
  const seen = await opening(page);
  expect(seen.platforms).toEqual(['youtube']);
  expect(seen.vt).not.toContain('tab');
  await shoot(page, '1-over-youtube');
  await page.close();
});

test('over another site: Chrome hides its URL, and the popup opens on the tab picked last', async () => {
  // the person picks Instagram once, in a popup opened over nothing in particular
  const pick = await context.newPage();
  await pick.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(pick.getByTestId('popup')).toHaveAttribute('data-platform', 'facebook');
  await pick.getByTestId('tab-instagram').click();
  await expect(pick.getByTestId('tab-instagram')).toHaveAttribute('aria-selected', 'true');
  await pick.close();

  expect(await realPopupOver(tabs.other)).toBe('instagram');

  const page = await popupOver(tabs.other);
  // no "tabs" permission and no host permission for this site: Chrome gives the popup no URL or title
  const under = await page.evaluate(() =>
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((t) => ({ n: t.length, url: t[0]?.url ?? null, title: t[0]?.title ?? null })),
  );
  expect(under).toEqual({ n: 1, url: null, title: null });
  await expect(page.getByTestId('popup')).toHaveAttribute('data-platform', 'instagram');
  // one platform from the first draw on, and never the tab slide (the loading → list fade is fine)
  const seen = await opening(page);
  expect(seen.platforms).toEqual(['instagram']);
  expect(seen.vt).not.toContain('tab');
  // nothing about that page was kept
  const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(kept).not.toContain(OTHER);
  expect(kept).not.toContain('example');
  await shoot(page, '2-over-other-site');
  await page.close();
});

test('on Facebook with no account saved: the main button adds the account on this tab', async () => {
  const page = await popupOver(tabs.facebook);
  await expect(page.getByTestId('popup')).toHaveAttribute('data-platform', 'facebook');
  await expect(page.getByTestId('empty')).toHaveAttribute('data-here', '1');
  await expect(page.getByTestId('open-site')).toHaveCount(0);
  await expect(page.getByTestId('add-account')).toHaveText(messages.add_here.message);
  await shoot(page, '3-on-site-empty');

  // setup: log in on the site itself, then add from the popup in place
  await tabs.facebook.goto(`https://${FB}${social.loginPath('100011112222', 'Alice')}`);
  await expect(tabs.facebook.locator('#who')).toHaveText('Alice');
  await page.getByTestId('add-account').click();
  await page.getByTestId('add-input').fill('Alice');
  await page.getByTestId('add-save').click();
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'list');
  await page.close();

  // a new popup over the same tab marks the account that tab is logged in to
  const again = await popupOver(tabs.facebook);
  const alice = again.locator('[data-testid^="row-"]').filter({ hasText: 'Alice' });
  await expect(alice.getByTestId('chip-here')).toHaveText(messages.chip_here.message);
  await expect(again.getByTestId('add-account')).toContainText(messages.add_here.message);
  await shoot(again, '4-on-site-list');
  await again.close();
});

test('locked: after the password, the popup is still on the site under it', async () => {
  const page = await popupOver(tabs.facebook);
  await page.getByTestId('settings-btn').click();
  await page.getByTestId('lock-now').click();
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'locked');
  await page.close();

  const locked = await popupOver(tabs.youtube);
  await expect(locked.getByTestId('popup')).toHaveAttribute('data-state', 'locked');
  await locked.getByTestId('pw-input').fill(PASSWORD);
  await locked.getByTestId('unlock').click();
  await expect(locked.getByTestId('popup')).toHaveAttribute('data-state', 'empty');
  await expect(locked.getByTestId('popup')).toHaveAttribute('data-platform', 'youtube');
  expect((await opening(locked)).platforms).toEqual(['youtube']);
  await locked.close();
});

test('nothing left the machine: the server saw only the fake sites', () => {
  for (const host of sites.hostsSeen) expect([...SOCIAL_HOSTS, YT]).toContain(host);
  expect(sites.hostsSeen.has(IG)).toBe(false);
});
