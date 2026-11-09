// A whole service worker on top of the fakes: real router, switcher, journal and keyring, fake Chrome.
import { dropCachedKey } from '../../src/background/keyring';
import { COOKIE_PLATFORMS } from '../../src/background/platforms';
import type { CookiePlatformId } from '../../src/background/platforms/types';
import {
  createRouter,
  type Router,
  type RouterDeps,
  type YoutubeIdentity,
  type YoutubeSwitcher,
} from '../../src/background/router';
import { clear } from '../../src/lib/cookies';
import { createMutex } from '../../src/lib/mutex';
import type { CookieSetDetails } from '../../src/lib/ports';
import { ok, type Result } from '../../src/lib/result';
import { type FakeChrome, fakeChrome } from './chrome';

export const PASSWORD = 'orange cat naps by the canal';
export const NOW = Date.UTC(2026, 0, 1);
const YEAR = 365 * 86400;

/** The value of the main session cookie for a user: what must never reach a log. */
export const secretOf = (user: string) => `xs-SECRET-${user}`;

const base = { path: '/', secure: true, httpOnly: false, sameSite: 'lax' } as const;

/** Logs the browser in as `user`, the way the real site would leave its cookies. */
/** `dated`: give every cookie an expiry date (by default some are session cookies). */
export async function loginAs(
  chrome: FakeChrome,
  platform: CookiePlatformId,
  user: string,
  dated = false,
) {
  const p = COOKIE_PLATFORMS[platform];
  await clear(chrome.cookies, p);
  const expires = chrome.clock.now / 1000 + YEAR;
  const url = `https://www.${p.cookieDomain}/`;
  const set = (d: Partial<CookieSetDetails> & Pick<CookieSetDetails, 'name' | 'value'>) =>
    chrome.cookies.set({
      url,
      ...base,
      domain: p.cookieDomain,
      ...(dated ? { expirationDate: expires } : {}),
      ...d,
    });
  if (platform === 'facebook') {
    await set({ name: 'c_user', value: user, expirationDate: expires });
    await set({
      name: 'xs',
      value: secretOf(user),
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: expires,
    });
    await set({ name: 'presence', value: `p-${user}` });
    const { domain: _d, ...hostOnly } = {
      ...base,
      url,
      name: 'host_only',
      value: `h-${user}`,
      domain: '',
    };
    if (dated) return;
    await chrome.cookies.set(hostOnly);
    await chrome.cookies.set({
      ...hostOnly,
      name: 'chips',
      value: `c-${user}`,
      sameSite: 'no_restriction',
      partitionKey: { topLevelSite: 'https://instagram.com' },
    });
  } else {
    await set({ name: 'ds_user_id', value: user, expirationDate: expires });
    await set({
      name: 'sessionid',
      value: secretOf(user),
      httpOnly: true,
      expirationDate: expires,
    });
    await set({ name: 'csrftoken', value: `csrf-${user}` });
  }
}

/** Device cookies the switch must never touch. */
export async function setDeviceCookies(chrome: FakeChrome) {
  await chrome.cookies.set({
    url: 'https://www.facebook.com/',
    ...base,
    name: 'datr',
    value: 'device-fb',
    domain: 'facebook.com',
  });
  await chrome.cookies.set({
    url: 'https://www.instagram.com/',
    ...base,
    name: 'mid',
    value: 'device-ig',
    domain: 'instagram.com',
  });
}

/** Who the browser is logged in as, by the platform's ID cookie. */
export const whoIs = (chrome: FakeChrome, platform: CookiePlatformId) =>
  chrome.cookies.all().find((c) => c.name === COOKIE_PLATFORMS[platform].idCookie)?.value ?? null;

export interface FakeYoutube extends YoutubeSwitcher {
  current: Result<YoutubeIdentity, 'no_youtube_tab' | 'not_logged_in'>;
  next: Result<{ reloadedTabs: number }, 'mismatch' | 'no_youtube_tab'>;
  switched: YoutubeIdentity[];
}

export function fakeYoutube(): FakeYoutube {
  const y: FakeYoutube = {
    current: ok({ authuser: 1, pageid: 'brand-7' }),
    next: ok({ reloadedTabs: 1 }),
    switched: [],
    readCurrent: async () => y.current,
    switchTo: async (target) => {
      y.switched.push(target);
      return y.next;
    },
  };
  return y;
}

export interface Harness {
  chrome: FakeChrome;
  deps: RouterDeps;
  router: Router;
  youtube: FakeYoutube;
  send(message: unknown): Promise<Result<unknown, string>>;
  /** Sends and fails the test unless the answer is ok. */
  must<T = unknown>(message: unknown): Promise<T>;
  /** A new worker on the same storage and cookies: cache dropped, busy set empty, recovery run. */
  restartWorker(): Promise<Harness>;
}

export function makeDeps(chrome: FakeChrome, youtube: YoutubeSwitcher): RouterDeps {
  let n = 0;
  return {
    extensionId: chrome.runtime.id,
    cookies: chrome.cookies,
    tabs: chrome.tabs,
    local: chrome.storage.local,
    session: chrome.storage.session,
    platforms: COOKIE_PLATFORMS,
    storeMutex: createMutex(),
    busy: new Set(),
    now: () => chrome.clock.now,
    newId: () => `acc-${++n}`,
    loadTimeoutMs: 50,
    youtube,
  };
}

export async function startWorker(
  chrome: FakeChrome = fakeChrome({ now: NOW }),
  youtube: FakeYoutube = fakeYoutube(),
): Promise<Harness> {
  dropCachedKey();
  const deps = makeDeps(chrome, youtube);
  const router = createRouter(deps);
  chrome.runtime.onMessage(router.handle);
  await router.ready;
  const send = (m: unknown) => chrome.runtime.send(m) as Promise<Result<unknown, string>>;
  const h: Harness = {
    chrome,
    deps,
    router,
    youtube,
    send,
    async must<T>(m: unknown) {
      const r = await send(m);
      if (!r.ok) throw new Error(`${JSON.stringify(m)} failed: ${r.error}`);
      return r.value as T;
    },
    restartWorker: () => startWorker(chrome, youtube),
  };
  return h;
}

/** Master password set, two Facebook accounts (1001 "Alice", 1002 "Bob") and two Instagram ones. */
export async function withAccounts(
  tabs: { url: string; active?: boolean }[] = [
    { url: 'https://www.facebook.com/', active: true },
    { url: 'https://m.facebook.com/groups' },
    { url: 'https://www.instagram.com/' },
    { url: 'https://example.com/' },
  ],
) {
  const h = await startWorker(fakeChrome({ now: NOW, tabs }));
  await setDeviceCookies(h.chrome);
  await h.must({ type: 'vault.setup', password: PASSWORD });
  const ids: Record<string, string> = {};
  for (const [platform, user, label] of [
    ['facebook', '1001', 'Alice'],
    ['facebook', '1002', 'Bob'],
    ['instagram', '2001', 'Shop'],
    ['instagram', '2002', 'Studio'],
  ] as const) {
    await loginAs(h.chrome, platform, user);
    ids[user] = (await h.must<{ id: string }>({ type: 'account.addCurrent', platform, label })).id;
  }
  // The browser ends up as Bob on Facebook and Studio on Instagram.
  return { h, ids };
}
