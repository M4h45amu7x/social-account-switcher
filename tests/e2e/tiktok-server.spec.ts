import { request } from 'node:https';
import { expect, test } from '@playwright/test';
import { fakeTikTok, TOKEN_GRACE_MS, TT } from './fake-tiktok';
import { startHttpsSites } from './https-sites';

// Requests go to the test listener itself, never a public host.
async function load(port: number, path: string, cookie = '') {
  return new Promise<{ cookies: string[]; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { host: TT, cookie }, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.on('data', (part) => {
          body += part;
        });
        res.on('end', () => resolve({ cookies: res.headers['set-cookie'] ?? [], body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
const session = (cookies: string[]) =>
  cookies.find((c) => c.startsWith('sessionid='))?.split(';')[0] ?? '';

test('TikTok server rotates each document and bounds grace; forged identities and revoked tokens fail', async () => {
  const fake = fakeTikTok();
  const sites = await startHttpsSites([TT], fake.handler);
  try {
    const login = await load(sites.port, '/__e2e/login?user=alice');
    const first = session(login.cookies);
    const a = await load(sites.port, '/', first);
    const second = session(a.cookies);
    expect(second).not.toBe(first);
    expect(a.body).toContain('"viewerId":"alice"');
    const b = await load(sites.port, '/video/1', second);
    const third = session(b.cookies);
    expect(third).not.toBe(second);
    // Retired generations may serve already-dispatched documents during the bounded grace window.
    const concurrent = await load(sites.port, '/concurrent', second);
    expect(concurrent.body).toContain('"viewerId":"alice"');
    expect(
      (await load(sites.port, '/forged-id', `${session(concurrent.cookies)}; uid_tt=bob`)).body,
    ).toContain('"viewerId":"alice"');
    fake.advance(TOKEN_GRACE_MS + 1);
    expect((await load(sites.port, '/stale', first)).body).toContain('logged_out');
    expect((await load(sites.port, '/', 'sessionid=forged; uid_tt=alice')).body).toContain(
      'logged_out',
    );
    fake.strict = true;
    const fresh = session((await load(sites.port, '/__e2e/login?user=bob')).cookies);
    const rotated = await load(sites.port, '/', fresh);
    expect(rotated.body).toContain('"viewerId":"bob"');
    expect((await load(sites.port, '/old', fresh)).body).toContain('logged_out');
    fake.revoke('bob');
    expect((await load(sites.port, '/', session(rotated.cookies))).body).toContain('logged_out');
  } finally {
    await sites.close();
  }
});

test('TikTok server grace admits three concurrent requests sent with the same generation', async () => {
  const fake = fakeTikTok();
  const sites = await startHttpsSites([TT], fake.handler);
  try {
    const login = await load(sites.port, '/__e2e/login?user=alice');
    const token = session(login.cookies);
    const responses = await Promise.all(
      ['/one', '/two', '/three'].map((path) => load(sites.port, path, token)),
    );
    expect(responses.map((r) => r.body.includes('"viewerId":"alice"'))).toEqual([true, true, true]);
    expect(new Set(responses.map((r) => session(r.cookies))).size).toBe(3);
  } finally {
    await sites.close();
  }
});
