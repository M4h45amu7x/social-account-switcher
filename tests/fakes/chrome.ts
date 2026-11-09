// In-memory fakes of the browser APIs in src/lib/ports.ts (docs/design.md 8.1 and 9.6).
// The cookie jar follows the Chrome rules the extension depends on, including the ones
// tests/e2e/cookies.spec.ts checked in real Chromium:
//   - getAll without partitionKey returns only unpartitioned cookies, `{}` returns every partition,
//     and `{ topLevelSite }` returns only that partition;
//   - remove() without the partitionKey leaves a partitioned cookie alone and still resolves;
//   - set() with `domain` makes a domain cookie (".example.com"), without it a host-only cookie;
//   - secure cookies need an https URL, SameSite=None and partitioned cookies need secure,
//     __Secure- and __Host- prefixes are enforced, and expired cookies disappear.
import type {
  BrowserCookie,
  BrowserTab,
  CookiePartitionKey,
  CookieSetDetails,
  CookiesApi,
  LifecycleApi,
  ScriptingApi,
  SessionAccessLevel,
  SessionStorageApi,
  StorageAreaApi,
  TabsApi,
} from '../../src/lib/ports';

export interface Clock {
  /** Milliseconds since the epoch, like Date.now(). */
  now: number;
}

// --- cookies ---

const bare = (domain: string): string => domain.replace(/^\./, '').toLowerCase();
const domainMatches = (host: string, domain: string): boolean =>
  host === bare(domain) || host.endsWith(`.${bare(domain)}`);
const pathMatches = (requestPath: string, cookiePath: string): boolean =>
  requestPath === cookiePath ||
  (requestPath.startsWith(cookiePath) &&
    (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));
/** RFC 6265 default-path: the URL path up to, not including, its last '/'. */
const defaultPath = (pathname: string): string =>
  pathname.lastIndexOf('/') > 0 ? pathname.slice(0, pathname.lastIndexOf('/')) : '/';
/** Good enough for the test domains: the last two labels. */
const siteOf = (host: string): string => `https://${host.split('.').slice(-2).join('.')}`;
const partitionOf = (c: { partitionKey?: CookiePartitionKey }): string =>
  c.partitionKey?.topLevelSite ?? '';

export interface FakeCookies extends CookiesApi {
  /** Every live cookie in the jar, as copies. */
  all(): BrowserCookie[];
  /** Every remove() call, for checking the URLs the code built. */
  removeCalls: Parameters<CookiesApi['remove']>[0][];
}

export function fakeCookies(clock: Clock = { now: Date.now() }): FakeCookies {
  let jar: BrowserCookie[] = [];
  const copy = (c: BrowserCookie): BrowserCookie => structuredClone(c);
  const live = (): BrowserCookie[] => {
    jar = jar.filter((c) => c.expirationDate === undefined || c.expirationDate * 1000 > clock.now);
    return jar;
  };
  const sameIdentity = (a: BrowserCookie, b: BrowserCookie) =>
    a.name === b.name &&
    a.domain === b.domain &&
    a.path === b.path &&
    partitionOf(a) === partitionOf(b);
  const fail = (why: string) => Promise.reject(new Error(`fake cookies.set: ${why}`));

  const api: FakeCookies = {
    removeCalls: [],
    all: () => live().map(copy),

    async getAll(details) {
      return live()
        .filter(
          (c) => details.domain === undefined || domainMatches(bare(c.domain), details.domain),
        )
        .filter((c) => details.name === undefined || c.name === details.name)
        .filter((c) => {
          if (details.partitionKey === undefined) return c.partitionKey === undefined;
          const site = details.partitionKey.topLevelSite;
          return site === undefined || c.partitionKey?.topLevelSite === site;
        })
        .map(copy);
    },

    set(details: CookieSetDetails) {
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        return fail('bad url');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('bad scheme');
      const host = url.hostname;
      if (details.domain !== undefined && !domainMatches(host, details.domain)) {
        return fail('domain does not match url');
      }
      const secure = details.secure;
      if (secure && url.protocol !== 'https:') return fail('secure cookie on http');
      if (details.sameSite === 'no_restriction' && !secure)
        return fail('SameSite=None needs secure');
      const path = details.path ?? defaultPath(url.pathname);
      const hostOnly = details.domain === undefined;
      if (details.name.startsWith('__Secure-') && !secure) return fail('__Secure- needs secure');
      if (details.name.startsWith('__Host-') && (!secure || !hostOnly || path !== '/')) {
        return fail('__Host- needs secure, host-only, path /');
      }
      const cookie: BrowserCookie = {
        name: details.name,
        value: details.value,
        domain: hostOnly ? host : `.${bare(details.domain ?? host)}`,
        path,
        hostOnly,
        secure,
        httpOnly: details.httpOnly,
        sameSite: details.sameSite,
        session: details.expirationDate === undefined,
      };
      if (details.expirationDate !== undefined) cookie.expirationDate = details.expirationDate;
      const site = details.partitionKey?.topLevelSite;
      if (site !== undefined) {
        if (!secure) return fail('partitioned cookie needs secure');
        cookie.partitionKey = {
          topLevelSite: site,
          hasCrossSiteAncestor: details.partitionKey?.hasCrossSiteAncestor ?? siteOf(host) !== site,
        };
      }
      jar = jar.filter((c) => !sameIdentity(c, cookie));
      if (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= clock.now) {
        return Promise.resolve(null); // setting an expired cookie deletes it
      }
      jar.push(cookie);
      return Promise.resolve(copy(cookie));
    },

    async remove(details) {
      api.removeCalls.push(structuredClone(details));
      const url = new URL(details.url);
      const site = details.partitionKey?.topLevelSite ?? '';
      jar = jar.filter(
        (c) =>
          !(
            c.name === details.name &&
            partitionOf(c) === site &&
            (c.hostOnly ? c.domain === url.hostname : domainMatches(url.hostname, c.domain)) &&
            pathMatches(url.pathname, c.path) &&
            (!c.secure || url.protocol === 'https:')
          ),
      );
      // Real Chrome resolves with the details whether or not a cookie was deleted.
      return { url: details.url, name: details.name };
    },
  };
  return api;
}

// --- storage ---

export interface FakeStorageArea extends StorageAreaApi {
  /** A JSON copy of everything stored, for asserting what reached this area. */
  dump(): Record<string, unknown>;
}

export function fakeStorageArea(): FakeStorageArea {
  const data = new Map<string, string>(); // values are kept as JSON, like Chrome does
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        const value = data.get(key);
        if (value !== undefined) out[key] = JSON.parse(value);
      }
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, JSON.stringify(value));
    },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) data.delete(key);
    },
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)])),
  };
}

export interface FakeSessionStorage extends SessionStorageApi, FakeStorageArea {
  accessLevel: SessionAccessLevel | null;
}

export function fakeSessionStorage(): FakeSessionStorage {
  const session: FakeSessionStorage = {
    ...fakeStorageArea(),
    accessLevel: null,
    async setAccessLevel({ accessLevel }) {
      session.accessLevel = accessLevel;
    },
  };
  return session;
}

// --- lifecycle ---

export interface FakeLifecycle extends LifecycleApi {
  /** Fires every registered handler, like Chrome does on install/update/startup. */
  fire(): void;
}

export function fakeLifecycle(): FakeLifecycle {
  const handlers: (() => void)[] = [];
  return {
    onInstalledOrStartup: (handler) => {
      handlers.push(handler);
    },
    fire: () => {
      for (const handler of handlers) handler();
    },
  };
}

// --- tabs ---

/** Chrome match pattern ("*://*.facebook.com/*") against a URL. */
export function matchesPattern(pattern: string, href: string): boolean {
  const m = /^(\*|https?):\/\/(\*|\*\.[^/]+|[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const s = url.protocol.slice(0, -1);
  if (scheme === '*' ? s !== 'http' && s !== 'https' : s !== scheme) return false;
  if (host !== '*') {
    const ok = host.startsWith('*.')
      ? domainMatches(url.hostname, host.slice(2))
      : url.hostname === host;
    if (!ok) return false;
  }
  const glob = new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return glob.test(url.pathname + url.search);
}

export interface FakeTabs extends TabsApi {
  tabs: BrowserTab[];
  reloaded: number[];
}

export function fakeTabs(initial: { url: string; active?: boolean }[] = []): FakeTabs {
  let nextId = 1;
  const make = (url: string, active = false): BrowserTab => ({
    id: nextId++,
    url,
    active,
    status: 'complete',
  });
  const fake: FakeTabs = {
    tabs: initial.map((t) => make(t.url, t.active)),
    reloaded: [],
    async query(query) {
      const patterns = query.url === undefined ? undefined : [query.url].flat();
      return fake.tabs
        .filter((t) => query.active === undefined || t.active === query.active)
        .filter((t) => !patterns || patterns.some((p) => matchesPattern(p, t.url ?? '')))
        .map((t) => ({ ...t }));
    },
    async reload(tabId) {
      if (!fake.tabs.some((t) => t.id === tabId)) throw new Error(`No tab with id: ${tabId}`);
      fake.reloaded.push(tabId);
    },
    async update(tabId, props) {
      const tab = fake.tabs.find((t) => t.id === tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      tab.url = props.url;
      return { ...tab };
    },
    async create(props) {
      const tab = make(props.url, true);
      fake.tabs.push(tab);
      return { ...tab };
    },
  };
  return fake;
}

// --- scripting ---

export interface FakeScripting extends ScriptingApi {
  /** What the injected function "returns" in each tab. Tabs not listed give no result. */
  pageResults: Map<number, unknown>;
  calls: { tabId: number; world: string }[];
}

export function fakeScripting(): FakeScripting {
  const fake: FakeScripting = {
    pageResults: new Map(),
    calls: [],
    async executeScript<T>(injection: Parameters<ScriptingApi['executeScript']>[0]) {
      const { tabId } = injection.target;
      fake.calls.push({ tabId, world: injection.world });
      return fake.pageResults.has(tabId) ? [{ result: fake.pageResults.get(tabId) as T }] : [{}];
    },
  };
  return fake;
}

// --- everything together ---

export interface FakeChrome {
  clock: Clock;
  cookies: FakeCookies;
  storage: { local: FakeStorageArea; session: FakeSessionStorage };
  tabs: FakeTabs;
  scripting: FakeScripting;
  lifecycle: FakeLifecycle;
}

export function fakeChrome(
  options: { now?: number; tabs?: { url: string; active?: boolean }[] } = {},
): FakeChrome {
  const clock: Clock = { now: options.now ?? Date.UTC(2026, 0, 1) };
  return {
    clock,
    cookies: fakeCookies(clock),
    storage: { local: fakeStorageArea(), session: fakeSessionStorage() },
    tabs: fakeTabs(options.tabs),
    scripting: fakeScripting(),
    lifecycle: fakeLifecycle(),
  };
}
