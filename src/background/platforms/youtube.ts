import type { BrowserTab, ScriptingApi, TabsApi, TabUpdatedListener } from '../../lib/ports';
import { err, ok, type Result } from '../../lib/result';
import type { YouTubeError, YouTubeSession, YoutubeSwitcher } from './types';

export interface YouTubeDeps {
  readonly tabs: TabsApi;
  readonly scripting: ScriptingApi;
  readonly loadTimeoutMs?: number;
}

// Resolved in the page MAIN world only. No module closure is serialized into the page.
declare const ytcfg: { get(key: string): unknown } | undefined;

/** Only these two non-secret primitives may leave the page. Never return the config object. */
function readPageSession(): unknown {
  try {
    if (typeof ytcfg === 'undefined' || !ytcfg) return null;
    const index = ytcfg.get('SESSION_INDEX');
    const pageid = ytcfg.get('DELEGATED_SESSION_ID');
    const authuser =
      typeof index === 'number'
        ? index
        : typeof index === 'string' && /^\d+$/.test(index)
          ? Number(index)
          : NaN;
    if (!Number.isSafeInteger(authuser) || authuser < 0) return null;
    if (pageid === undefined || pageid === null || pageid === '') return { authuser };
    if (typeof pageid !== 'string' || !/^\d+$/.test(pageid)) return null;
    return { authuser, pageid };
  } catch {
    return null;
  }
}

function validSession(value: unknown): value is YouTubeSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<YouTubeSession>;
  return (
    typeof session.authuser === 'number' &&
    Number.isSafeInteger(session.authuser) &&
    session.authuser >= 0 &&
    (session.pageid === undefined ||
      (typeof session.pageid === 'string' && /^\d+$/.test(session.pageid)))
  );
}

const YOUTUBE_TABS = ['*://*.youtube.com/*'];

/** Longer `next` values are replaced by '/': a real YouTube path is far shorter (design 3.3). */
export const MAX_NEXT_LENGTH = 2048;
/** Layers of percent-encoding `safeNext` looks through before it gives up and uses '/'. */
export const MAX_DECODE_ROUNDS = 3;

function isYouTubeUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

const hasControlOrBackslash = (value: string) =>
  [...value].some((char) => char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

const unsafePath = (path: string) => path.startsWith('//') || hasControlOrBackslash(path);

/** After the first round, a lone '%' is literal (it came from a legitimate %25). */
const decodeOnce = (path: string, first: boolean) =>
  decodeURIComponent(first ? path : path.replace(/%(?![a-f\d]{2})/gi, '%25'));

/**
 * Accept paths only; URL parser normalization alone would allow network-path redirects. The length
 * cap and the fixed number of decode rounds keep the cost linear in a URL any web page can set.
 */
function safeNext(next: string): string {
  try {
    if (next.length > MAX_NEXT_LENGTH) return '/';
    if (!next.startsWith('/') || next.startsWith('//')) return '/';
    if (hasControlOrBackslash(next)) return '/';
    // Validate path independently: a literal percent in query/fragment must not hide a redirect.
    const path = next.split(/[?#]/)[0] ?? '/';
    let decoded = path;
    for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
      if (unsafePath(decoded)) return '/';
      const unescaped = decodeOnce(decoded, round === 0);
      if (unescaped === decoded) return next;
      decoded = unescaped;
    }
    // Still encoded after the last round: too deep to be a real path.
    return !unsafePath(decoded) && decodeOnce(decoded, false) === decoded ? next : '/';
  } catch {
    return '/';
  }
}

/** The path of a URL or of a `next` path; YouTube may add or change query parameters on redirect. */
function pathOf(value: string): string {
  return new URL(value, 'https://www.youtube.com').pathname;
}

/** URL format still needs B7 manual test 19 with real Brand/personal accounts (design.md 8.3). */
export function buildSignInUrl(
  session: YouTubeSession,
  next: string,
): Result<string, YouTubeError> {
  if (!validSession(session)) return err('invalid_session');
  const params = new URLSearchParams({
    action_handle_signin: 'true',
    authuser: String(session.authuser),
  });
  if (session.pageid !== undefined) params.set('pageid', session.pageid);
  params.set('next', safeNext(next));
  return ok(`https://www.youtube.com/signin?${params}`);
}

export async function readSession(
  deps: YouTubeDeps,
  tabId: number,
): Promise<Result<YouTubeSession, YouTubeError>> {
  try {
    const tab = await deps.tabs.get(tabId);
    if (!isYouTubeUrl(tab.url)) return err('invalid_tab');
    const results = await deps.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readPageSession,
    });
    const value = results.find((item) => item.frameId === 0)?.result;
    if (!validSession(value)) return err('not_signed_in');
    // Copy only the allow-listed fields even if the page supplies additional properties.
    return ok(
      value.pageid === undefined
        ? { authuser: value.authuser }
        : { authuser: value.authuser, pageid: value.pageid },
    );
  } catch {
    return err('api_error');
  }
}

/**
 * Navigates and waits until that navigation has loaded (design 3.3). Chrome reports `url` in
 * onUpdated only when the committed URL changes, and never for a host without permission (Google's
 * login page), so the anchor is the moment update()/create() resolves: the first loading → complete
 * of the target tab after it is the requested navigation. A visible URL on another path in between
 * means someone else navigated the tab, so the wait goes on until the timeout. A complete with no
 * loading after the anchor is the old document and is ignored, so the old page is never read.
 * Resolves with the tab as it is after the load.
 */
async function navigateAndWait(
  deps: YouTubeDeps,
  signin: string,
  next: string,
  navigate: () => Promise<BrowserTab | undefined>,
): Promise<BrowserTab | undefined> {
  let listener: TabUpdatedListener | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<BrowserTab | undefined>((resolve, reject) => {
      let target: number | undefined;
      /** Tabs that started loading the signin URL before the anchor (it is unique to this switch). */
      const early = new Set<number>();
      let loading = false;
      let elsewhere = false;
      const ours = (url: string) =>
        url === signin || (isYouTubeUrl(url) && [pathOf(next), '/signin'].includes(pathOf(url)));
      const done = (id: number) => {
        deps.tabs.get(id).then(resolve, reject);
      };
      listener = (id, change) => {
        if (target === undefined) {
          if (change.status === 'loading' && change.url === signin) early.add(id);
          return;
        }
        if (id !== target) return;
        if (change.url !== undefined) elsewhere = !ours(change.url);
        if (change.status === 'loading') loading = true;
        if (change.status === 'complete' && loading && !elsewhere) done(id);
      };
      // Subscribe before navigation, including create(), whose tab id is not yet known.
      deps.tabs.onUpdated.addListener(listener);
      timer = setTimeout(
        () => reject(new Error('tab load timed out')),
        deps.loadTimeoutMs ?? 15_000,
      );
      navigate().then((tab) => {
        if (tab?.id === undefined) {
          resolve(tab);
          return;
        }
        const id = tab.id;
        target = id;
        loading = early.has(id);
        // Loaded before update() resolved: only the signin URL itself proves it is the new page.
        deps.tabs.get(id).then((current) => {
          if (current.status === 'complete' && current.url === signin) resolve(current);
        }, reject);
      }, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (listener) deps.tabs.onUpdated.removeListener(listener);
  }
}

export async function verifySession(
  deps: YouTubeDeps,
  tabId: number,
  expected: YouTubeSession,
): Promise<Result<void, YouTubeError>> {
  if (!validSession(expected)) return err('invalid_session');
  const current = await readSession(deps, tabId);
  if (!current.ok) return current;
  return current.value.authuser === expected.authuser && current.value.pageid === expected.pageid
    ? ok(undefined)
    : err('not_signed_in');
}

async function youTubeTabs(deps: YouTubeDeps): Promise<BrowserTab[]> {
  return (await deps.tabs.query({ url: YOUTUBE_TABS })).filter((tab) => isYouTubeUrl(tab.url));
}

export async function switchAccount(
  deps: YouTubeDeps,
  session: YouTubeSession,
): Promise<Result<{ tabId: number; reloadedTabs: number }, YouTubeError>> {
  try {
    if (!validSession(session)) return err('invalid_session');
    const tabs = await youTubeTabs(deps);
    const selected = tabs.find((tab) => tab.active) ?? tabs[0];
    let next = '/';
    if (selected?.url) {
      const url = new URL(selected.url);
      next = safeNext(url.pathname + url.search + url.hash);
    }
    const signin = buildSignInUrl(session, next);
    if (!signin.ok) return signin;
    const target = await navigateAndWait(deps, signin.value, next, () =>
      selected?.id !== undefined
        ? deps.tabs.update(selected.id, { url: signin.value, active: true })
        : deps.tabs.create({ url: signin.value, active: true }),
    );
    if (target?.id === undefined) return err('invalid_tab');
    // Google sends an account that isn't logged in to its login page (design 3.3). Without a
    // google.com permission Chrome hides that URL, so anything that isn't visibly YouTube counts.
    if (!isYouTubeUrl(target.url)) return err('not_signed_in');
    const verified = await verifySession(deps, target.id, session);
    if (!verified.ok) return verified;
    let reloadedTabs = 0;
    for (const tab of tabs) {
      if (tab.id === undefined || tab.id === target.id) continue;
      try {
        await deps.tabs.reload(tab.id);
        reloadedTabs++;
      } catch {
        // Closed during the switch: nothing to reload, and the switch itself worked.
      }
    }
    return ok({ tabId: target.id, reloadedTabs });
  } catch {
    return err('api_error');
  }
}

/** The YouTube side of the router (design 3.3): read the open tab's account, or switch to one. */
export function createYoutubeSwitcher(deps: YouTubeDeps): YoutubeSwitcher {
  return {
    async readCurrent() {
      try {
        const tabs = await youTubeTabs(deps);
        const tab = tabs.find((t) => t.active) ?? tabs[0];
        if (tab?.id === undefined) return err('no_youtube_tab');
        return await readSession(deps, tab.id);
      } catch {
        return err('api_error');
      }
    },
    async switchTo(target) {
      const switched = await switchAccount(deps, target);
      return switched.ok ? ok({ reloadedTabs: switched.value.reloadedTabs }) : switched;
    },
  };
}
