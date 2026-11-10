// Card B6 (docs/design.md 8.3 tests 15 to 19 and 21): the built extension in Chromium against a fake
// www.facebook.com and www.instagram.com (tests/e2e/fake-social.ts) served by the shared local https
// server. Everything is done the way a person would, by clicking the real popup. The only exceptions are
// marked "setup" (logging in on the fake site, revoking a session on its server) and "read" (asking the
// worker for an account's stored status, reading cookies through CDP).
import type { BrowserContext, CDPSession, Locator, Page } from '@playwright/test';
import { FB, fakeSocial, IG, OTHER, SOCIAL_HOSTS } from './fake-social';
import { expect, test } from './fixtures';
import { callSite, type HttpsSites, launchWithSites } from './https-sites';

const PASSWORD = 'orange cat naps by the canal';
const PEOPLE = {
  facebook: [
    { id: '100011112222', name: 'Alice' },
    { id: '100033334444', name: 'Bob' },
  ],
  instagram: [
    { id: '5550001111', name: 'Carol' },
    { id: '5550002222', name: 'Dave' },
  ],
} as const;
type Platform = keyof typeof PEOPLE;
const HOST: Record<Platform, string> = { facebook: FB, instagram: IG };
const DEVICE: Record<Platform, string[]> = {
  facebook: ['datr', 'sb'],
  instagram: ['mid', 'ig_did'],
};
const DOMAIN: Record<Platform, string> = { facebook: 'facebook.com', instagram: 'instagram.com' };

let context: BrowserContext;
let sites: HttpsSites;
let closeAll: () => Promise<void>;
let extensionId = '';
const social = fakeSocial();

/** Test 19: what the extension's own pages and its worker asked the network for, and every dialog. */
const traffic = { worker: [] as string[], popup: [] as string[], other: [] as string[] };
const dialogs: string[] = [];
const pageErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const launched = await launchWithSites(SOCIAL_HOSTS, social.handler);
  context = launched.context;
  sites = launched.sites;
  closeAll = launched.close;
  context.on('request', (r) => {
    const url = r.url();
    if (r.serviceWorker()) traffic.worker.push(url);
    // a popup page, or a tab that is loading the popup (its URL is still about:blank)
    else if (`${r.frame().page().url()} ${url}`.includes('chrome-extension://'))
      traffic.popup.push(url);
    else traffic.other.push(url);
  });
  context.on('page', (page) => {
    page.on('dialog', (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      void d.dismiss();
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await closeAll?.();
});

// ---------------------------------------------------------------------------------------------------
// helpers

const tabs = {} as Record<Platform, Page>;
let popup: Page;
let cdp: CDPSession;

async function openPopup(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(page.getByTestId('popup')).not.toHaveAttribute('data-state', 'loading');
  return page;
}

/** setup: what a person does on the site's own login page. */
async function logIn(platform: Platform, who: { id: string; name: string }) {
  const tab = tabs[platform];
  await tab.goto(`https://${HOST[platform]}${social.loginPath(who.id, who.name)}`);
  await expect(tab.locator('#who')).toHaveAttribute('data-user', who.id);
}

const showing = (platform: Platform) => tabs[platform].locator('#who');

const row = (page: Page, label: string): Locator =>
  page.locator('[data-testid^="row-"]').filter({ hasText: label });

async function pickPlatform(page: Page, platform: Platform) {
  await page.getByTestId(`tab-${platform}`).click();
  await expect(page.getByTestId(`tab-${platform}`)).toHaveAttribute('aria-selected', 'true');
}

async function addAccount(page: Page, platform: Platform, label: string) {
  // Reopen over the site's tab as a person does: profile probes now bind to the
  // active tab captured at popup startup, including when switching platform tabs.
  await page.evaluate(async (host) => {
    const [site] = await chrome.tabs.query({ url: `https://${host}/*`, currentWindow: true });
    if (site?.id === undefined) throw new Error('missing fake site tab');
    await chrome.tabs.update(site.id, { active: true });
  }, HOST[platform]);
  await page.reload();
  await pickPlatform(page, platform);
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('add-form')).toBeVisible();
  await page.getByTestId('add-input').fill(label);
  await page.getByTestId('add-save').click();
  await expect(row(page, label)).toBeVisible();
}

/** Clicks the account's row and waits until the switch has ended one way or the other. */
async function clickSwitch(page: Page, label: string) {
  const button = row(page, label).locator('button.main');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('popup')).not.toHaveAttribute('data-state', 'switching', {
    timeout: 30_000,
  });
}

async function switchTo(page: Page, platform: Platform, who: { id: string; name: string }) {
  await pickPlatform(page, platform);
  await clickSwitch(page, who.name);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(row(page, who.name)).toHaveClass(/active/);
  await expect(showing(platform)).toHaveAttribute('data-user', who.id);
  await expect(showing(platform)).toHaveText(who.name);
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite?: string;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

/** read: every cookie of the platform, partitioned ones included, straight from the browser (CDP). */
async function cookiesOf(platform: Platform): Promise<CdpCookie[]> {
  const { cookies } = (await cdp.send('Storage.getCookies')) as { cookies: CdpCookie[] };
  return cookies.filter((c) => c.domain.replace(/^\./, '').endsWith(DOMAIN[platform]));
}

/** Every attribute that restore must keep, in one comparable string per cookie. */
const shape = (c: CdpCookie) =>
  JSON.stringify({
    name: c.name,
    value: c.value,
    domain: c.domain, // a leading dot = a Domain cookie, none = host-only
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite ?? 'unset',
    session: c.session,
    expires: c.session ? -1 : Math.round(c.expires),
    partitionKey: c.partitionKey ?? null,
  });

const sessionShapes = (platform: Platform, all: CdpCookie[]) =>
  all
    .filter((c) => !DEVICE[platform].includes(c.name))
    .map(shape)
    .sort();
const deviceShapes = (platform: Platform, all: CdpCookie[]) =>
  all
    .filter((c) => DEVICE[platform].includes(c.name))
    .map(shape)
    .sort();

/** read: the worker's own record of the accounts (the popup shows only "log in again"). */
async function storedStatus(page: Page, label: string): Promise<string | undefined> {
  const answer = (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'state.get' }))) as {
    value: { accounts: { label: string; status: string }[] };
  };
  return answer.value.accounts.find((a) => a.label === label)?.status;
}

const original = new Map<string, string[]>();

// ---------------------------------------------------------------------------------------------------

test('15: add two accounts per site, switch back and forth five times, cookies come back exactly', async () => {
  test.setTimeout(240_000);
  tabs.facebook = await context.newPage();
  tabs.instagram = await context.newPage();
  cdp = await context.newCDPSession(tabs.facebook);

  popup = await openPopup();
  await expect(popup.getByTestId('popup')).toHaveAttribute('data-state', 'setup');
  await popup.getByTestId('pw-input').fill(PASSWORD);
  await popup.getByTestId('setup-create').click();
  await expect(popup.getByTestId('popup')).toHaveAttribute('data-state', 'empty');

  for (const platform of ['facebook', 'instagram'] as const) {
    for (const who of PEOPLE[platform]) {
      await logIn(platform, who);
      original.set(who.id, sessionShapes(platform, await cookiesOf(platform)));
      await addAccount(popup, platform, who.name);
    }
    // the fake sets every kind of cookie the restore has to get right
    const all = await cookiesOf(platform);
    expect(all.some((c) => c.partitionKey)).toBe(true);
    expect(all.some((c) => !c.domain.startsWith('.'))).toBe(true);
    expect(all.some((c) => c.session)).toBe(true);
    expect(all.some((c) => c.httpOnly)).toBe(true);
    expect(new Set(all.map((c) => c.sameSite ?? 'unset')).size).toBeGreaterThanOrEqual(3);
  }

  for (const platform of ['facebook', 'instagram'] as const) {
    const [first, second] = PEOPLE[platform];
    const device = deviceShapes(platform, await cookiesOf(platform));
    expect(device).toHaveLength(2);
    for (const who of [first, second, first, second, first]) {
      await switchTo(popup, platform, who);
      const now = await cookiesOf(platform);
      expect(deviceShapes(platform, now), `${platform} device cookies`).toEqual(device);
      expect(sessionShapes(platform, now), `${who.name}'s cookies`).toEqual(original.get(who.id));
    }
  }
});

test('17: every tab of the site reloads, another site is not touched, FB and IG switch together', async () => {
  test.setTimeout(120_000);
  const fbMore = await context.newPage();
  await fbMore.goto(`https://${FB}/groups/`);
  const igMore = await context.newPage();
  await igMore.goto(`https://${IG}/explore/`);
  const other = await context.newPage();
  await other.goto(`https://${OTHER}/today`);
  const pages = [tabs.facebook, fbMore, tabs.instagram, igMore, other];
  // a mark that only a reload removes
  for (const p of pages)
    await p.evaluate(() => Object.assign(document.body.dataset, { mark: '1' }));
  const loadsBefore = new Map(social.loads);

  // two popups, one per site, clicked at the same moment
  const fbPopup = await openPopup();
  const igPopup = await openPopup();
  await pickPlatform(fbPopup, 'facebook');
  await pickPlatform(igPopup, 'instagram');
  const [bob, dave] = [PEOPLE.facebook[1], PEOPLE.instagram[1]];
  await Promise.all([
    row(fbPopup, bob.name).locator('button.main').click(),
    row(igPopup, dave.name).locator('button.main').click(),
  ]);
  for (const [page, who] of [
    [fbPopup, bob],
    [igPopup, dave],
  ] as const) {
    await expect(page.getByTestId('popup')).not.toHaveAttribute('data-state', 'switching', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('error')).toHaveCount(0);
    await expect(row(page, who.name)).toHaveClass(/active/);
    await expect(page.getByTestId('toast')).toContainText('2');
  }

  for (const p of [tabs.facebook, fbMore]) await expect(p.locator('#who')).toHaveText(bob.name);
  for (const p of [tabs.instagram, igMore]) await expect(p.locator('#who')).toHaveText(dave.name);
  for (const p of pages.slice(0, 4))
    expect(await p.evaluate(() => document.body.dataset.mark)).toBeUndefined();
  expect(await other.evaluate(() => document.body.dataset.mark)).toBe('1');
  const grew = (key: string) => (social.loads.get(key) ?? 0) - (loadsBefore.get(key) ?? 0);
  expect(grew(`${FB}/`)).toBe(1);
  expect(grew(`${FB}/groups/`)).toBe(1);
  expect(grew(`${IG}/`)).toBe(1);
  expect(grew(`${IG}/explore/`)).toBe(1);
  expect(grew(`${OTHER}/today`)).toBe(0);
  for (const p of [fbMore, igMore, other, fbPopup, igPopup]) await p.close();
});

test('18: lock, a wrong password, unlock and switch; a stopped worker does not ask again', async () => {
  test.setTimeout(120_000);
  await popup.getByTestId('settings-btn').click();
  await popup.getByTestId('lock-now').click();
  await expect(popup.getByTestId('popup')).toHaveAttribute('data-state', 'locked');

  await popup.getByTestId('pw-input').fill('not the password at all');
  await popup.getByTestId('unlock').click();
  await expect(popup.getByTestId('pw-hint')).toHaveText('Wrong password. Try again.');
  await expect(popup.getByTestId('popup')).toHaveAttribute('data-state', 'locked');

  await popup.getByTestId('pw-input').fill(PASSWORD);
  await popup.getByTestId('unlock').click();
  await expect(popup.getByTestId('popup')).toHaveAttribute('data-state', 'list');
  await switchTo(popup, 'facebook', PEOPLE.facebook[0]);
  await popup.close();

  // Stop the worker the way Chrome does when it is idle, and wait until it really is stopped.
  const states: string[] = [];
  const versions = new Set<string>();
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
    for (const v of e.versions as { versionId: string; scriptURL: string; runningStatus: string }[])
      if (v.scriptURL.includes(extensionId)) {
        versions.add(v.versionId);
        states.push(v.runningStatus);
      }
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => versions.size).toBeGreaterThan(0);
  for (const versionId of versions) await cdp.send('ServiceWorker.stopWorker', { versionId });
  await expect.poll(() => states.at(-1)).toBe('stopped');

  popup = await openPopup();
  await expect(popup.getByTestId('popup')).toHaveAttribute('data-state', 'list');
  await expect(popup.getByTestId('pw-input')).toHaveCount(0);
  await switchTo(popup, 'facebook', PEOPLE.facebook[1]);
  await switchTo(popup, 'instagram', PEOPLE.instagram[0]);
  // the answers came from a worker that started again after the stop
  expect(states.slice(states.lastIndexOf('stopped'))).toContain('running');
  await cdp.send('ServiceWorker.disable');
});

test('16: a session revoked on the server shows the error and keeps the previous account; a checkpoint is marked', async () => {
  test.setTimeout(120_000);
  const [alice, bob] = PEOPLE.facebook;
  await switchTo(popup, 'facebook', alice);
  // setup: Bob signs out of every device on Facebook itself
  expect(await callSite(sites, FB, `/__e2e/revoke?user=${bob.id}`)).toBe(204);

  await pickPlatform(popup, 'facebook');
  await clickSwitch(popup, bob.name);
  await expect(popup.getByTestId('error')).toBeVisible();
  await expect(popup.getByTestId('error')).toContainText(bob.name);
  await expect(row(popup, alice.name)).toHaveClass(/active/);
  // a real rollback: Alice's cookies are back, and the site still knows her after a fresh load
  await expect(showing('facebook')).toHaveAttribute('data-user', alice.id);
  expect(sessionShapes('facebook', await cookiesOf('facebook'))).toEqual(original.get(alice.id));
  await tabs.facebook.reload();
  await expect(showing('facebook')).toHaveText(alice.name);
  expect(await storedStatus(popup, bob.name)).toBe('expired');
  await popup.getByTestId('error-close').click();

  // Instagram asks Dave to confirm it's him: the switch counts, the account is marked checkpoint.
  const dave = PEOPLE.instagram[1];
  expect(await callSite(sites, IG, `/__e2e/checkpoint?user=${dave.id}&on=1`)).toBe(204);
  await pickPlatform(popup, 'instagram');
  await clickSwitch(popup, dave.name);
  await expect(popup.getByTestId('error')).toBeVisible();
  await expect(popup.getByTestId('error-open')).toBeVisible();
  await expect(tabs.instagram).toHaveURL(`https://${IG}/challenge/`);
  expect(await storedStatus(popup, dave.name)).toBe('checkpoint');
  expect(await callSite(sites, IG, `/__e2e/checkpoint?user=${dave.id}&on=0`)).toBe(204);
  await popup.getByTestId('error-close').click();
});

test('21: with reduced motion, switch, tab change, theme change, delete and the toast animate nothing', async () => {
  test.setTimeout(120_000);
  await popup.close();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Samples document.getAnimations() on every frame, from before the popup's first script.
  await page.addInitScript(() => {
    const seen: string[] = [];
    let frames = 0;
    const tick = () => {
      frames += 1;
      for (const a of document.getAnimations())
        seen.push(
          (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id,
        );
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Object.assign(globalThis, { motion: { seen, frames: () => frames } });
  });
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'list');
  popup = page;
  const animations = () =>
    page.evaluate(() => (globalThis as unknown as { motion: { seen: string[] } }).motion.seen);

  // switch: check while the spinner is on screen, then after the toast
  const carol = PEOPLE.instagram[0];
  await pickPlatform(page, 'instagram');
  await row(page, carol.name).locator('button.main').click();
  await expect(page.locator('.spinner')).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(page.getByTestId('popup')).not.toHaveAttribute('data-state', 'switching', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('toast')).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(page.getByTestId('toast')).toBeHidden({ timeout: 10_000 });

  // tab change
  await pickPlatform(page, 'facebook');
  // theme change, there and back
  await page.getByTestId('settings-btn').click();
  await page.getByTestId('s-theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('s-theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  await page.getByTestId('settings-back').click();
  // delete the account whose session was revoked
  const bob = PEOPLE.facebook[1];
  await row(page, bob.name).locator('[data-testid^="delete-"]').click();
  await page.getByTestId('delete-confirm').click();
  await expect(row(page, bob.name)).toHaveCount(0);

  expect(await animations()).toEqual([]);
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as { motion: { frames(): number } }).motion.frames(),
    ),
  ).toBeGreaterThan(30);
});

test('22: a saved Dark theme on a light OS is on <html> before <body> exists', async () => {
  // saved the way a person does it
  await popup.getByTestId('settings-btn').click();
  await popup.getByTestId('s-theme-dark').click();
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
  await popup.close();

  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  // Records, in document order, when data-theme was set on <html> and when <body> was inserted.
  await page.addInitScript(() => {
    const order: string[] = [];
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target === document.documentElement)
          order.push(`theme=${document.documentElement.getAttribute('data-theme')}`);
        for (const n of r.addedNodes) if (n.nodeName === 'BODY') order.push('body');
      }
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    Object.assign(globalThis, { firstPaint: order });
  });
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'list');
  const order = await page.evaluate(
    () => (globalThis as unknown as { firstPaint: string[] }).firstPaint,
  );
  expect(order.indexOf('theme=dark')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('theme=dark')).toBeLessThan(order.indexOf('body'));
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)).toBe(true);

  // back to System for whoever runs next
  await page.getByTestId('settings-btn').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-vt-busy', '1');
  await page.getByTestId('s-theme-system').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  popup = page;
});

test('19: nothing left the extension, every page stayed on the fake sites, no dialog opened', () => {
  const extensionOnly = (u: string) => u.startsWith(`chrome-extension://${extensionId}/`);
  expect(traffic.worker.filter((u) => !extensionOnly(u))).toEqual([]);
  expect(traffic.popup.filter((u) => !extensionOnly(u))).toEqual([]);
  expect(
    traffic.other.filter((u) => !SOCIAL_HOSTS.some((h) => u.startsWith(`https://${h}/`))),
  ).toEqual([]);
  expect([...sites.hostsSeen].sort()).toEqual([...SOCIAL_HOSTS].sort());
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);
});
