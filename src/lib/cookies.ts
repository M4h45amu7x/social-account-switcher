// Read, clear and restore one platform's session cookies (docs/design.md 3.0, 3.4 and 8.2).
// Stateless: every function gets the cookies API as a parameter. Nothing here logs, because cookie
// values are as good as a password.
import type { CookiePlatform } from '../background/platforms/types';
import type {
  BrowserCookie,
  CookiePartitionKey,
  CookieSetDetails,
  CookiesApi,
  SameSite,
} from './ports';
import { err, ok, type Result } from './result';

/** A cookie as kept in the vault (design 5, SessionMap). */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Seconds since the epoch. Missing means a session cookie. */
  expirationDate?: number;
  partitionKey?: CookiePartitionKey;
}

const bareDomain = (domain: string): string => domain.replace(/^\./, '').toLowerCase();

/** True when `domain` is the platform's domain or one of its subdomains. */
function belongsTo(domain: string, platformDomain: string): boolean {
  const d = bareDomain(domain);
  const p = bareDomain(platformDomain);
  return d === p || d.endsWith(`.${p}`);
}

/** The URL Chrome needs to address a cookie: scheme from `secure`, then host and path. */
export function cookieUrl(
  cookie: Pick<StoredCookie, 'secure' | 'domain' | 'path'>,
  httpsOnly = false,
): string {
  return `${cookie.secure || httpsOnly ? 'https' : 'http'}://${bareDomain(cookie.domain)}${cookie.path}`;
}

/** Every cookie of the platform's domain in every partition, minus the device cookies. */
async function sessionCookies(api: CookiesApi, p: CookiePlatform): Promise<BrowserCookie[]> {
  // `partitionKey: {}` asks for all partitions at once; without it CHIPS cookies are left out.
  const all = await api.getAll({ domain: p.cookieDomain, partitionKey: {} });
  return all.filter((c) => isSessionCookie(c, p));
}

/** Platform-scoped rule used for reads and optional scoped restore, including journal backups. */
export function isSessionCookie(c: StoredCookie, p: CookiePlatform): boolean {
  return (
    belongsTo(c.domain, p.cookieDomain) &&
    !p.deviceCookies.has(c.name) &&
    (!p.httpsOnly || /^[.]?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(c.domain))
  );
}

function toStored(c: BrowserCookie): StoredCookie {
  const stored: StoredCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    hostOnly: c.hostOnly,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  };
  if (!c.session && c.expirationDate !== undefined) stored.expirationDate = c.expirationDate;
  if (c.partitionKey) stored.partitionKey = { ...c.partitionKey };
  return stored;
}

export async function snapshot(api: CookiesApi, p: CookiePlatform): Promise<StoredCookie[]> {
  return (await sessionCookies(api, p)).map(toStored);
}

/**
 * Removes the platform's session cookies (device cookies stay). Returns how many are gone, counted by
 * reading the cookies again: Chrome's remove() resolves even when it deleted nothing.
 */
export async function clear(api: CookiesApi, p: CookiePlatform): Promise<number> {
  const before = await sessionCookies(api, p);
  for (const c of before) {
    const details: Parameters<CookiesApi['remove']>[0] = {
      url: cookieUrl(c, p.httpsOnly),
      name: c.name,
    };
    // Without the partitionKey Chrome resolves but leaves a partitioned cookie in place.
    if (c.partitionKey) details.partitionKey = c.partitionKey;
    // A rejected call is caught here and shows up as a cookie that is still there.
    await api.remove(details).catch(() => null);
  }
  return before.length - (await sessionCookies(api, p)).length;
}

export const isExpired = (c: StoredCookie, now: number): boolean =>
  c.expirationDate !== undefined && c.expirationDate * 1000 <= now;

function toSetDetails(c: StoredCookie, httpsOnly = false): CookieSetDetails {
  const details: CookieSetDetails = {
    url: cookieUrl(c, httpsOnly),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
  };
  // Passing `domain` would turn a host-only cookie into a domain cookie.
  if (!c.hostOnly) details.domain = c.domain;
  if (c.expirationDate !== undefined) details.expirationDate = c.expirationDate;
  if (c.partitionKey) details.partitionKey = c.partitionKey;
  return details;
}

/**
 * Sets the saved cookies again, skipping any that have expired by `now` (milliseconds).
 * Returns how many Chrome accepted (a rejected cookie counts as not set), or `all_expired` when
 * every saved cookie has expired.
 */
export async function restore(
  api: CookiesApi,
  cookies: StoredCookie[],
  now: number,
  platform?: CookiePlatform,
): Promise<Result<number, 'all_expired' | 'invalid_session'>> {
  if (platform && cookies.some((c) => !isSessionCookie(c, platform))) return err('invalid_session');
  const live = cookies.filter((c) => !isExpired(c, now));
  if (cookies.length > 0 && live.length === 0) return err('all_expired');
  let set = 0;
  for (const c of live) {
    if (await api.set(toSetDetails(c, platform?.httpsOnly)).catch(() => null)) set += 1;
  }
  return ok(set);
}

/** The user ID in the platform's ID cookie, or null when nobody is signed in. */
export async function currentUserId(api: CookiesApi, p: CookiePlatform): Promise<string | null> {
  const found = await api.getAll({ domain: p.cookieDomain, name: p.idCookie });
  return found.find((c) => belongsTo(c.domain, p.cookieDomain) && c.value !== '')?.value ?? null;
}
