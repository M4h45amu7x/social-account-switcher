// In-memory fakes of the browser APIs in src/lib/ports.ts (docs/design.md 8.1 and 9.6).
// The cookie jar follows the Chrome rules the extension depends on, including the ones
// tests/e2e/cookies.spec.ts checked in real Chromium:
//   - getAll without partitionKey returns only unpartitioned cookies, `{}` returns every partition,
//     and `{ topLevelSite }` returns only that partition;
//   - remove() without the partitionKey leaves a partitioned cookie alone and still resolves;
//   - set() with `domain` makes a domain cookie (".example.com"), without it a host-only cookie;
//   - secure cookies need an https URL, SameSite=None and partitioned cookies need secure,
//     __Secure- and __Host- prefixes are enforced, and expired cookies disappear;
//   - the partition is topLevelSite plus hasCrossSiteAncestor: two cookies that differ only in the
//     flag are separate, and remove() with the wrong flag deletes nothing;
//   - set() with a path the URL doesn't reach, or an expired date, resolves with undefined;
//   - without host permission for the URL, set() and remove() throw and getAll() leaves those
//     cookies out.
// QC t-535 compared these cases with Chromium.
import type {
  BrowserCookie,
  BrowserTab,
  CookiePartitionKey,
  CookieSetDetails,
  CookiesApi,
  LifecycleApi,
  MessageSender,
  RuntimeApi,
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
const partitionOf = (c: { partitionKey?: CookiePartitionKey | undefined }): string =>
  c.partitionKey?.topLevelSite === undefined
    ? ''
    : `${c.partitionKey.topLevelSite}|${c.partitionKey.hasCrossSiteAncestor === true}`;
/** Chromium's default for a missing flag: true when the cookie's site isn't the top-level site. */
function fillPartition(host: string, key?: CookiePartitionKey): CookiePartitionKey | undefined {
  if (key?.topLevelSite === undefined) return undefined;
  const flag = key.hasCrossSiteAncestor ?? siteOf(host) !== key.topLevelSite;
  return { topLevelSite: key.topLevelSite, hasCrossSiteAncestor: flag };
}

/** The extension's host_permissions (src/manifest.json). */
export const MANIFEST_HOSTS = [
  '*://*.facebook.com/*',
  '*://*.instagram.com/*',
  '*://*.youtube.com/*',
];

export interface FakeCookies extends CookiesApi {
  /** Every live cookie in the jar, as copies. */
  all(): BrowserCookie[];
  /** Every remove() call, for checking the URLs the code built. */
  removeCalls: Parameters<CookiesApi['remove']>[0][];
}

export function fakeCookies(
  clock: Clock = { now: Date.now() },
  hostPermissions: readonly string[] = MANIFEST_HOSTS,
): FakeCookies {
  let jar: BrowserCookie[] = [];
  const allowed = (host: string) =>
    hostPermissions.some((p) => matchesPattern(p, `https://${host}/`));
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
        .filter((c) => allowed(bare(c.domain)))
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
      if (!allowed(host)) return fail('no host permission for url');
      if (details.domain !== undefined && !domainMatches(host, details.domain)) {
        return fail('domain does not match url');
      }
      const secure = details.secure;
      if (secure && url.protocol !== 'https:') return fail('secure cookie on http');
      if (details.sameSite === 'no_restriction' && !secure)
        return fail('SameSite=None needs secure');
      const path = details.path ?? defaultPath(url.pathname);
      const hostOnly = details.domain === undefined;
      if (!pathMatches(url.pathname, path)) return Promise.resolve(undefined);
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
      const partitionKey = fillPartition(host, details.partitionKey);
      if (partitionKey) {
        if (!secure) return fail('partitioned cookie needs secure');
        cookie.partitionKey = partitionKey;
      }
      jar = jar.filter((c) => !sameIdentity(c, cookie));
      if (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 <= clock.now) {
        return Promise.resolve(undefined); // setting an expired cookie deletes it
      }
      jar.push(cookie);
      return Promise.resolve(copy(cookie));
    },

    async remove(details) {
      api.removeCalls.push(structuredClone(details));
      const url = new URL(details.url);
      if (!allowed(url.hostname)) throw new Error('fake cookies.remove: no host permission');
      const site = partitionOf({ partitionKey: fillPartition(url.hostname, details.partitionKey) });
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
  /**
   * Runs while a reloaded tab "loads", before it reports complete. Tests use it to play the server:
   * change the tab's URL (a checkpoint redirect) or drop cookies (a revoked session).
   */
  onLoad: ((tab: BrowserTab) => void | Promise<void>) | null;
  /** When false, a reload never finishes loading (to test the verify timeout). */
  finishLoading: boolean;
}

export function fakeTabs(initial: { url: string; active?: boolean }[] = []): FakeTabs {
  let nextId = 1;
  const listeners = new Set<Parameters<TabsApi['onUpdated']>[0]>();
  const make = (url: string, active = false): BrowserTab => ({
    id: nextId++,
    url,
    active,
    status: 'complete',
  });
  const find = (tabId: number) => {
    const tab = fake.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  };
  const emit = (tab: BrowserTab, info: { status: string }) => {
    tab.status = info.status;
    for (const l of [...listeners]) l(tab.id ?? -1, { ...info, url: tab.url }, { ...tab });
  };
  const fake: FakeTabs = {
    tabs: initial.map((t) => make(t.url, t.active)),
    reloaded: [],
    onLoad: null,
    finishLoading: true,
    async query(query) {
      const patterns = query.url === undefined ? undefined : [query.url].flat();
      return fake.tabs
        .filter((t) => query.active === undefined || t.active === query.active)
        .filter((t) => !patterns || patterns.some((p) => matchesPattern(p, t.url ?? '')))
        .map((t) => ({ ...t }));
    },
    async get(tabId) {
      return { ...find(tabId) };
    },
    onUpdated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async reload(tabId) {
      const tab = find(tabId);
      fake.reloaded.push(tabId);
      emit(tab, { status: 'loading' });
      // Like Chrome, the page loads after reload() has resolved.
      setTimeout(async () => {
        await fake.onLoad?.(tab);
        if (fake.finishLoading) emit(tab, { status: 'complete' });
      }, 0);
    },
    async update(tabId, props) {
      const tab = find(tabId);
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

// --- runtime ---

export interface FakeRuntime extends RuntimeApi {
  /** Delivers a message the way Chrome would and resolves with the handler's answer. */
  send(message: unknown, sender?: MessageSender): Promise<unknown>;
  /** The sender a message from this extension's own popup has. */
  readonly popupSender: MessageSender;
}

export function fakeRuntime(id = 'abcdefghijklmnopabcdefghijklmnop'): FakeRuntime {
  let handler: Parameters<RuntimeApi['onMessage']>[0] | null = null;
  const popupSender = { id, url: `chrome-extension://${id}/popup/index.html` };
  return {
    id,
    popupSender,
    onMessage(h) {
      handler = h;
    },
    send(message, sender = popupSender) {
      if (!handler) return Promise.reject(new Error('no onMessage handler'));
      return handler(structuredClone(message), sender);
    },
  };
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
  runtime: FakeRuntime;
}

export function fakeChrome(
  options: {
    now?: number;
    tabs?: { url: string; active?: boolean }[];
    hostPermissions?: readonly string[];
  } = {},
): FakeChrome {
  const clock: Clock = { now: options.now ?? Date.UTC(2026, 0, 1) };
  return {
    clock,
    cookies: fakeCookies(clock, options.hostPermissions),
    storage: { local: fakeStorageArea(), session: fakeSessionStorage() },
    tabs: fakeTabs(options.tabs),
    scripting: fakeScripting(),
    lifecycle: fakeLifecycle(),
    runtime: fakeRuntime(),
  };
}
