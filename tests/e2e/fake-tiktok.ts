// Local model of the unconfirmed app-context candidate. Tokens are server-side capabilities, never viewer IDs.
// Grace accepts retired generations for 1,000 ms after retirement, without extending their expiry
// on reuse. This permits concurrent documents; strict mode accepts only the current generation.
import { createHash, randomBytes } from 'node:crypto';
import { PNG } from '../fixtures/profile';
import type { SiteHandler } from './https-sites';

export const TOKEN_GRACE_MS = 1000;
export const TT = 'www.tiktok.com';
export const TT_OTHER = 'news.example.org';
// Keep fictional display handles separate from immutable numeric IDs.
export const fixtureUid = (user: string): string => {
  if (/^[1-9][0-9]{0,31}$/.test(user)) return user;
  if (user === 'alice') return '7100000000000000001';
  if (user === 'bob') return '7100000000000000002';
  return (
    BigInt(`0x${createHash('sha256').update(user).digest('hex').slice(0, 15)}`) + 1n
  ).toString();
};
const hydration = (user: string | null) => ({
  __DEFAULT_SCOPE__: {
    'webapp.app-context': {
      isLogin: user !== null,
      user:
        user === null
          ? null
          : { uid: fixtureUid(user), uniqueId: user, nickname: `${user} Profile`, avatar: PNG },
    },
    'webapp.video-detail': {
      author: {
        uid: '9999999999999999999',
        uniqueId: 'misleading.author',
        nickname: 'Feed author',
        avatar: PNG,
      },
      userInfo: { user: { uid: '8888888888888888888' } },
    },
  },
});
export type ViewerMode = 'normal' | 'missing' | 'malformed' | 'logout' | 'checkpoint' | 'captcha';
interface Chain {
  user: string;
  generation: number;
  current: string;
  retired: Map<string, number>;
}
const token = () => randomBytes(20).toString('hex');
const escapeHtml = (value: string) => value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function fakeTikTok() {
  const chains: Chain[] = [];
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const accepts = (c: Chain, value: string) =>
    value !== '' && (c.current === value || (!fake.strict && (c.retired.get(value) ?? 0) > now()));
  const loads = new Map<string, number>();
  const accepted: { user: string; generation: number; token: string }[] = [];
  const rejected: string[] = [];
  const modes = new Map<string, ViewerMode>();
  const fake = {
    strict: false,
    loads,
    accepted,
    rejected,
    modes,
    delays: new Map<string, number>(),
    advance(ms: number) {
      clockOffset += ms;
    },
    revoke(user: string) {
      for (const chain of chains)
        if (chain.user === user) {
          chain.current = '';
          chain.retired.clear();
        }
    },
    valid(value: string, user: string) {
      return chains.some((c) => c.user === user && accepts(c, value));
    },
    handler: ((req, res, url) => {
      const respond = () => {
        loads.set(
          `${url.hostname}${url.pathname}`,
          (loads.get(`${url.hostname}${url.pathname}`) ?? 0) + 1,
        );
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (url.hostname !== TT) {
          res.end('<h1>Unrelated news page</h1>');
          return;
        }
        const cookies = new Map(
          (req.headers.cookie ?? '').split(';').map((s) => {
            const i = s.indexOf('=');
            return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
          }),
        );
        const sessionCookies = (chain: Chain) => [
          `sessionid=${chain.current}; Domain=.tiktok.com; Path=/; Secure; HttpOnly; SameSite=Lax`,
          `uid_tt=${fixtureUid(chain.user)}; Domain=.tiktok.com; Path=/; Secure; SameSite=Lax`,
          `companion_unknown=${chain.current}; Path=/; Secure; HttpOnly; SameSite=Strict`,
          `partition_session=${chain.user}; Path=/; Secure; SameSite=None; Partitioned`,
          `multi_sids=${chain.user}; Domain=.tiktok.com; Path=/; Secure; SameSite=Lax`,
        ];
        if (url.pathname === '/__e2e/login') {
          const chain: Chain = {
            user: url.searchParams.get('user') ?? 'alice',
            generation: 0,
            current: token(),
            retired: new Map(),
          };
          chains.push(chain);
          const device = [
            'ttwid',
            'msToken',
            's_v_web_id',
            'tt_chain_token',
            'odin_tt',
            'tt_ticket_guard_has_set_public_key',
            'security_verification_ticket',
            'x-web-secsdk-uid',
            'gd_random',
          ].flatMap((name) =>
            cookies.has(name)
              ? []
              : [
                  `${name}=device-${name}; Domain=.tiktok.com; Path=/; Secure; HttpOnly; SameSite=None`,
                ],
          );
          if (!cookies.has('msToken'))
            device.push('msToken=host-device; Path=/; Secure; HttpOnly; SameSite=None');
          res.writeHead(302, {
            location: '/',
            'set-cookie': [...sessionCookies(chain), ...device],
          });
          res.end();
          return;
        }
        const sent = cookies.get('sessionid') ?? '';
        const chain = chains.find((c) => accepts(c, sent));
        if (!chain) {
          if (sent) rejected.push(sent);
          res.setHeader(
            'set-cookie',
            'sessionid=; Domain=.tiktok.com; Path=/; Max-Age=0; Secure; HttpOnly',
          );
          res.end(
            '<h1 id="who" data-user="">Log in</h1><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.app-context":{"isLogin":false,"user":null}}}</script>',
          );
          return;
        }
        for (const [old, expires] of chain.retired) if (expires <= now()) chain.retired.delete(old);
        chain.retired.set(chain.current, now() + TOKEN_GRACE_MS);
        chain.current = token();
        chain.generation++;
        accepted.push({ user: chain.user, generation: chain.generation, token: chain.current });
        res.setHeader('set-cookie', sessionCookies(chain));
        const mode = modes.get(chain.user) ?? 'normal';
        const state =
          mode === 'malformed'
            ? '{broken'
            : JSON.stringify(hydration(mode === 'logout' ? null : chain.user));
        res.end(
          `<!doctype html><meta charset="utf-8"><title>TikTok fixture</title><h1 id="who" data-user="${escapeHtml(chain.user)}" data-generation="${chain.generation}">${escapeHtml(chain.user)}</h1><a href="/video/next">Next</a>${mode === 'captcha' ? '<div id="captcha_container"></div>' : mode === 'checkpoint' ? '<div id="verifyEle"></div>' : ''}<p id="manual">${mode === 'captcha' ? 'Complete the captcha yourself' : mode === 'checkpoint' ? 'Verify your identity in this tab' : ''}</p><script type="application/json" id="feed">{"author":{"id":"impostor"},"profile":{"id":"impostor"},"viewerId":"impostor"}</script>${mode === 'missing' ? '' : `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${state}</script>`}`,
        );
      };
      const delay = fake.delays.get(url.pathname) ?? 0;
      if (delay) setTimeout(respond, delay);
      else respond();
    }) as SiteHandler,
  };
  return fake;
}
