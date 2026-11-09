// Design 3.3 in a real Chromium: the built extension switches YouTube accounts against a local https
// server that plays www.youtube.com and accounts.google.com, with real 302 redirects. Chrome only
// reports `url` in tabs.onUpdated when the committed URL changes and hides Google's URL entirely,
// which the unit fakes can only imitate (QC t-546). The server is the shared one in https-sites.ts:
// every other host resolves to nothing, so no request leaves the machine.
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { type HttpsSites, launchWithSites, type SiteHandler } from './https-sites';

const ORIGINAL = 'https://www.youtube.com/watch?v=abc&list=def';

type Mode = 'same' | 'extra' | 'direct' | 'google' | 'slow';
type Session = Record<string, string>;

/** A tiny YouTube + Google: the page's ytcfg shows whichever account signin last selected. */
function fakeGoogle() {
  const state = {
    mode: 'same' as Mode,
    current: { SESSION_INDEX: '0' } as Session,
  };
  const page = (title: string, session: Session) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<script>var ytcfg={get:function(k){return (${JSON.stringify(session)})[k]}}</script>${title}`;
  const handler: SiteHandler = (_req, res, url) => {
    const host = url.hostname;
    const html = (title: string, session: Session) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(page(title, session));
    };
    const redirect = (to: string) => {
      res.writeHead(302, { location: to, 'cache-control': 'no-store' });
      res.end();
    };
    if (host === 'accounts.google.com') return html('Sign in - Google Accounts', {});
    if (url.pathname !== '/signin') return html(`YouTube ${url.pathname}`, state.current);
    const next = url.searchParams.get('next') ?? '/';
    if (state.mode === 'google') {
      // Account N is not logged in to Google: off to the login page, nothing selected.
      return redirect('https://accounts.google.com/v3/signin/identifier?continue=youtube');
    }
    const authuser = url.searchParams.get('authuser') ?? '0';
    const pageid = url.searchParams.get('pageid');
    state.current = pageid
      ? { SESSION_INDEX: authuser, DELEGATED_SESSION_ID: pageid }
      : { SESSION_INDEX: authuser };
    const back = `https://www.youtube.com${next}`;
    if (state.mode === 'same') return redirect(back);
    if (state.mode === 'extra')
      return redirect(`${back}${next.includes('?') ? '&' : '?'}feature=signin`);
    if (state.mode === 'direct') return html('YouTube signin', state.current);
    // 'slow': the answer comes late, so the user has time to click somewhere else.
    setTimeout(() => redirect(back), 3000);
  };
  return { handler, state };
}

let sites: HttpsSites;
let google: ReturnType<typeof fakeGoogle>['state'];
let context: BrowserContext;
let closeAll: () => Promise<void>;

test.beforeAll(async () => {
  const made = fakeGoogle();
  google = made.state;
  const launched = await launchWithSites(['www.youtube.com', 'accounts.google.com'], made.handler);
  context = launched.context;
  sites = launched.sites;
  closeAll = launched.close;
});

test.afterAll(async () => {
  await closeAll?.();
});

type Answer = { ok: boolean; value?: unknown; error?: string };
const send = (popup: Page, message: unknown) =>
  popup.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<Answer>;

test('switching YouTube accounts through real redirects in Chromium', async () => {
  test.setTimeout(90_000);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  const youtube = await context.newPage();
  google.current = { SESSION_INDEX: '0' };
  await youtube.goto(ORIGINAL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  // Two accounts, read from the page's ytcfg.
  const personal = await send(popup, {
    type: 'account.addCurrent',
    platform: 'youtube',
    label: 'Me',
  });
  expect(personal).toMatchObject({ ok: true, value: { youtube: { authuser: 0 } } });
  google.current = { SESSION_INDEX: '2', DELEGATED_SESSION_ID: '12345' };
  await youtube.reload();
  const brand = await send(popup, {
    type: 'account.addCurrent',
    platform: 'youtube',
    label: 'Brand',
  });
  expect(brand).toMatchObject({ ok: true, value: { youtube: { authuser: 2, pageid: '12345' } } });
  const id = (a: Answer) => (a.value as { id: string }).id;

  /** The onUpdated events the worker got during each switch (for the same-URL check below). */
  const seen: string[] = [];
  const timed = async (accountId: string) => {
    await youtube.bringToFront();
    const started = Date.now();
    await sw.evaluate(() => {
      const log: string[] = [];
      const listener = (_id: number, change: object) => {
        log.push(JSON.stringify(change));
      };
      chrome.tabs.onUpdated.addListener(listener);
      Object.assign(globalThis, { switchLog: { log, listener } });
    });
    const answer = await send(popup, { type: 'account.switch', accountId });
    const ms = Date.now() - started;
    seen.push(
      ...(await sw.evaluate(() => {
        const { log, listener } = (
          globalThis as unknown as { switchLog: { log: string[]; listener: () => void } }
        ).switchLog;
        chrome.tabs.onUpdated.removeListener(listener);
        return log;
      })),
    );
    return { answer, ms };
  };

  // 1. The usual case: signin answers 302 back to the URL the tab already had. Chrome puts `url` in
  //    onUpdated only when it differs from the last URL it reported while a listener was there, so
  //    the first switch may still get one, but the second switch in a row from the same page gets
  //    a bare {status: 'loading'} (as QC t-546 saw with a listener kept registered).
  google.mode = 'same';
  for (const account of [personal, brand, personal]) {
    const r = await timed(id(account));
    expect(r.answer).toEqual({ ok: true, value: { reloadedTabs: 0 } });
    expect(r.ms).toBeLessThan(5000);
    expect(youtube.url()).toBe(ORIGINAL);
  }
  expect(seen.some((e) => e.includes('"status":"loading"}'))).toBe(true);

  // 2. signin answers 200 itself.
  google.mode = 'direct';
  let r = await timed(id(brand));
  expect(r.answer).toEqual({ ok: true, value: { reloadedTabs: 0 } });
  expect(new URL(youtube.url()).pathname).toBe('/signin');

  // 3. The redirect adds a query parameter on the way back.
  await youtube.goto(ORIGINAL);
  google.mode = 'extra';
  r = await timed(id(personal));
  expect(r.answer).toEqual({ ok: true, value: { reloadedTabs: 0 } });
  expect(youtube.url()).toBe(`${ORIGINAL}&feature=signin`);

  // 4. Google account N is not logged in: Google's login page, whose URL the extension can't see.
  await youtube.goto(ORIGINAL);
  google.mode = 'google';
  r = await timed(id(brand));
  expect(r.answer).toEqual({ ok: false, error: 'not_signed_in' });
  expect(r.ms).toBeLessThan(5000);
  expect(new URL(youtube.url()).host).toBe('accounts.google.com');
  const state = (await send(popup, { type: 'state.get' })).value as {
    accounts: { id: string; status: string }[];
  };
  expect(state.accounts.find((a) => a.id === id(brand))?.status).toBe('expired');

  // 5. The user clicks somewhere else while signin is still answering: that page is not read, the
  //    switch gives up after its 15-second timeout, and no account is marked.
  await youtube.goto(ORIGINAL);
  google.mode = 'slow';
  google.current = { SESSION_INDEX: '7' };
  const pending = timed(id(personal));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await youtube.goto('https://www.youtube.com/feed/library');
  r = await pending;
  expect(r.answer).toEqual({ ok: false, error: 'api_error' });
  expect(r.ms).toBeGreaterThan(14_000);
  const after = (await send(popup, { type: 'state.get' })).value as {
    accounts: { id: string; status: string }[];
    busy: string[];
  };
  expect(after.accounts.find((a) => a.id === id(personal))?.status).toBe('ok');
  expect(after.busy).toEqual([]);

  // Only the two local stand-ins were ever asked for anything.
  expect([...sites.hostsSeen].sort()).toEqual(['accounts.google.com', 'www.youtube.com']);
});
