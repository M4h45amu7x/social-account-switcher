// Interfaces for every browser API the extension uses (docs/design.md 8.2).
// Logic receives these as parameters, so it can be unit-tested with fakes, and every async method is
// typed as returning a Promise here. That is what lets Biome's noFloatingPromises catch a missing
// `await`: Biome does not infer return types from @types/chrome, so `chrome` is banned outside the
// adapter files (src/background/chrome-adapter.ts, src/popup/runtime.ts).
//
// What `bun run lint` catches outside the adapters:
//   - Biome: the globals chrome, globalThis, self, window, frames, parent and top, so `chrome.x`,
//     `globalThis.chrome`, `self['chrome']`, `const { chrome } = window` and `const g = globalThis`.
//   - scripts/check-chrome-access.ts: any `chrome` word left after comments and types are stripped,
//     including strings and `document.defaultView.chrome`.
// It does not catch a name built at runtime (`self['ch' + 'rome']`) or eval-like code. That is left to
// code review. Samples of each case live in tests/lint-fixtures/.

export type SessionAccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';

/** chrome.storage.local / chrome.storage.session. Values must survive a JSON round trip. */
export interface StorageAreaApi {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface SessionStorageApi extends StorageAreaApi {
  setAccessLevel(options: { accessLevel: SessionAccessLevel }): Promise<void>;
}

export interface LifecycleApi {
  /** Runs `handler` when the extension is installed or updated, and when the browser starts. */
  onInstalledOrStartup(handler: () => void): void;
}

export interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
  getUILanguage(): string;
}

export type SameSite = 'no_restriction' | 'lax' | 'strict' | 'unspecified';

/** A CHIPS partition. Chrome 130+ also reports `hasCrossSiteAncestor`; keep it when present. */
export interface CookiePartitionKey {
  topLevelSite?: string;
  hasCrossSiteAncestor?: boolean;
}

/** The fields of chrome.cookies.Cookie this extension reads. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  session: boolean;
  expirationDate?: number;
  partitionKey?: CookiePartitionKey;
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  /** Leave out for a host-only cookie: passing it turns the cookie into a domain cookie. */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Seconds since the epoch. Leave out for a session cookie. */
  expirationDate?: number;
  partitionKey?: CookiePartitionKey;
}

export interface CookiesApi {
  /**
   * `partitionKey: {}` returns unpartitioned and partitioned cookies together; without it Chrome
   * returns only unpartitioned ones (checked in Chromium by tests/e2e/cookies.spec.ts).
   */
  getAll(details: {
    domain?: string;
    name?: string;
    partitionKey?: CookiePartitionKey;
  }): Promise<BrowserCookie[]>;
  /** Resolves with no cookie (null or undefined) when Chrome stored nothing, e.g. an expired cookie. */
  set(details: CookieSetDetails): Promise<BrowserCookie | null | undefined>;
  /**
   * A partitioned cookie is only removed when its partitionKey is passed. Without it Chrome still
   * resolves with the details, so the result can't tell you whether anything was deleted.
   */
  remove(details: {
    url: string;
    name: string;
    partitionKey?: CookiePartitionKey;
  }): Promise<{ url: string; name: string } | null>;
}

export interface BrowserTab {
  id?: number | undefined;
  url?: string | undefined;
  active: boolean;
  status?: string | undefined;
}

export interface TabUpdateInfo {
  status?: string | undefined;
  url?: string | undefined;
}

export interface TabsApi {
  get(tabId: number): Promise<BrowserTab>;
  /** Subscribes to chrome.tabs.onUpdated. Returns a function that unsubscribes. */
  onUpdated(listener: (tabId: number, info: TabUpdateInfo, tab: BrowserTab) => void): () => void;
  query(query: { url?: string | string[]; active?: boolean }): Promise<BrowserTab[]>;
  reload(tabId: number): Promise<void>;
  update(tabId: number, props: { url: string }): Promise<BrowserTab | undefined>;
  create(props: { url: string }): Promise<BrowserTab>;
}

/** Who sent a runtime message (the fields of chrome.runtime.MessageSender this code reads). */
export interface MessageSender {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown;
}

export interface RuntimeApi {
  /** This extension's ID. */
  readonly id: string;
  /**
   * Answers each runtime message with what `handler` resolves to. The handler must not reject; the
   * adapter keeps the message channel open until it settles.
   */
  onMessage(handler: (message: unknown, sender: MessageSender) => Promise<unknown>): void;
}

export interface ScriptingApi {
  /** Runs `func` in the page's MAIN world and returns its result for each frame. */
  executeScript<T>(injection: {
    target: { tabId: number };
    world: 'MAIN';
    func: () => T;
  }): Promise<{ result?: T }[]>;
}
