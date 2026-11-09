// A small Facebook and Instagram for the e2e specs (docs/design.md 8.3 tests 15 to 19). Logging in sets
// cookies with the real names and a mix of attributes: Domain and host-only, Secure, HttpOnly, every
// SameSite value, one session cookie and one Partitioned (CHIPS) cookie per site. A page shows who the
// cookies belong to, or the login page when there is no valid session. Like the real sites, a session
// the server no longer knows gets its cookies deleted on the next load.
//
// Control endpoints (POST, called by the test through callSite, never by the browser):
//   /__e2e/revoke?user=ID          the server forgets every session of ID ("log out of all devices")
//   /__e2e/checkpoint?user=ID&on=1 ID's next page loads go to the identity check
// The browser logs in through GET /__e2e/login?user=ID&name=NAME, which sets the cookies and goes to /.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SiteHandler } from './https-sites';

export const FB = 'www.facebook.com';
export const IG = 'www.instagram.com';
/** A third site, to prove a switch leaves other domains' tabs alone. */
export const OTHER = 'news.example.org';
export const SOCIAL_HOSTS = [FB, IG, OTHER] as const;

type Site = 'facebook' | 'instagram';

interface SiteRules {
  readonly domain: string;
  readonly idCookie: string;
  readonly sessionCookie: string;
  readonly checkpointPath: string;
  /** Device cookies: set once per browser, or again at every login. Never part of a session. */
  readonly deviceOnce: string;
  readonly deviceAtLogin: string;
  /** Set-Cookie lines for a fresh session of `user`, the device cookies excluded. */
  session(user: string, token: string): string[];
}

const YEAR = 'Max-Age=31536000';
const token = () => randomBytes(12).toString('hex');

const RULES: Record<Site, SiteRules> = {
  facebook: {
    domain: '.facebook.com',
    idCookie: 'c_user',
    sessionCookie: 'xs',
    checkpointPath: '/checkpoint/1501092823525282/',
    deviceOnce: 'datr',
    deviceAtLogin: 'sb',
    session: (user, xs) => [
      `c_user=${user}; Domain=.facebook.com; Path=/; ${YEAR}; Secure; SameSite=None`,
      `xs=${xs}; Domain=.facebook.com; Path=/; ${YEAR}; Secure; HttpOnly; SameSite=None`,
      `fr=${token()}; Domain=.facebook.com; Path=/; ${YEAR}; Secure; HttpOnly; SameSite=Lax`,
      // host-only (no Domain), a session cookie (no expiry), SameSite=Strict
      `presence=${token()}; Path=/; Secure; SameSite=Strict`,
      // CHIPS: kept in the facebook.com partition
      `usida=${token()}; Path=/; ${YEAR}; Secure; SameSite=None; Partitioned`,
    ],
  },
  instagram: {
    domain: '.instagram.com',
    idCookie: 'ds_user_id',
    sessionCookie: 'sessionid',
    checkpointPath: '/challenge/',
    deviceOnce: 'mid',
    deviceAtLogin: 'ig_did',
    session: (user, sessionid) => [
      `sessionid=${sessionid}; Domain=.instagram.com; Path=/; ${YEAR}; Secure; HttpOnly; SameSite=Lax`,
      `ds_user_id=${user}; Domain=.instagram.com; Path=/; ${YEAR}; Secure; SameSite=Lax`,
      `csrftoken=${token()}; Domain=.instagram.com; Path=/; ${YEAR}; Secure; SameSite=Lax`,
      // host-only, HttpOnly, a session cookie, SameSite=Strict
      `rur=${token()}; Path=/; Secure; HttpOnly; SameSite=Strict`,
      // CHIPS with a Domain attribute
      `shbid=${token()}; Domain=.instagram.com; Path=/; ${YEAR}; Secure; SameSite=None; Partitioned`,
    ],
  },
};

const SITE_OF: Record<string, Site> = { [FB]: 'facebook', [IG]: 'instagram' };

function readCookies(req: IncomingMessage): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return jar;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, title: string, body: string, cookies: string[] = []) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>${body}`);
}

function redirect(res: ServerResponse, to: string, cookies: string[] = []) {
  res.writeHead(302, {
    location: to,
    'cache-control': 'no-store',
    ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
  });
  res.end();
}

export function fakeSocial() {
  /** session token → user id, per site. A revoked user's tokens are deleted. */
  const sessions: Record<Site, Map<string, string>> = { facebook: new Map(), instagram: new Map() };
  const names = new Map<string, string>();
  const checkpoint = new Set<string>();
  /** Page loads per host and path, to count reloads. */
  const loads = new Map<string, number>();

  const handler: SiteHandler = (req, res, url) => {
    const host = url.hostname;
    loads.set(`${host}${url.pathname}`, (loads.get(`${host}${url.pathname}`) ?? 0) + 1);
    if (host === OTHER) {
      page(res, 'News', `<h1 id="who" data-user="">News</h1><p>${escapeHtml(url.pathname)}</p>`);
      return;
    }
    const site = SITE_OF[host];
    if (!site) {
      res.writeHead(404);
      res.end();
      return;
    }
    const rules = RULES[site];
    const user = url.searchParams.get('user') ?? '';

    if (url.pathname.startsWith('/__e2e/')) {
      const action = url.pathname.slice('/__e2e/'.length);
      if (action === 'login' && req.method === 'GET') {
        const jar = readCookies(req);
        const fresh = token();
        sessions[site].set(fresh, user);
        names.set(`${site}:${user}`, url.searchParams.get('name') ?? user);
        const device = [
          `${rules.deviceAtLogin}=${token()}; Domain=${rules.domain}; Path=/; ${YEAR}; Secure; HttpOnly; SameSite=None`,
        ];
        if (!jar.has(rules.deviceOnce))
          device.push(
            `${rules.deviceOnce}=${token()}; Domain=${rules.domain}; Path=/; ${YEAR}; Secure; HttpOnly; SameSite=None`,
          );
        redirect(res, '/', [...rules.session(user, fresh), ...device]);
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (action === 'revoke') {
        for (const [t, u] of sessions[site]) if (u === user) sessions[site].delete(t);
      } else if (action === 'checkpoint') {
        if (url.searchParams.get('on') === '1') checkpoint.add(`${site}:${user}`);
        else checkpoint.delete(`${site}:${user}`);
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const jar = readCookies(req);
    const id = jar.get(rules.idCookie);
    const sent = jar.get(rules.sessionCookie);
    const owner = sent === undefined ? undefined : sessions[site].get(sent);
    if (sent !== undefined && (owner === undefined || owner !== id)) {
      // The server no longer knows this session: it deletes the session cookies, as the real ones do.
      const gone = [rules.idCookie, rules.sessionCookie].map(
        (n) => `${n}=deleted; Domain=${rules.domain}; Path=/; Max-Age=0; Secure`,
      );
      page(res, 'Log in', '<h1 id="who" data-user="">Log in</h1>', gone);
      return;
    }
    if (owner === undefined) {
      page(res, 'Log in', '<h1 id="who" data-user="">Log in</h1>');
      return;
    }
    // The identity check holds the user on its page; anyone else who lands there is sent home.
    const held = checkpoint.has(`${site}:${owner}`);
    if (held !== (url.pathname === rules.checkpointPath)) {
      redirect(res, held ? rules.checkpointPath : '/');
      return;
    }
    const name = names.get(`${site}:${owner}`) ?? owner;
    page(
      res,
      name,
      `<h1 id="who" data-user="${escapeHtml(owner)}">${escapeHtml(name)}</h1><p>${escapeHtml(url.pathname)}</p>`,
    );
  };

  return {
    handler,
    loads,
    loginPath: (user: string, name: string) =>
      `/__e2e/login?${new URLSearchParams({ user, name })}`,
  };
}
