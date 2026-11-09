// Card B3: the built service worker in Chromium, driven through chrome.runtime messages from the
// extension's own page. Two Facebook accounts are added and switched back and forth; the real cookie
// store must hold the right person each time. (The fake https sites and tab checks are card B6.)
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

const PASSWORD = 'orange cat naps by the canal';
const secret = (user: string) => `xs-SECRET-${user}`;

async function worker(context: import('@playwright/test').BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/** Replaces the Facebook session cookies with `user`'s; the device cookie datr stays. */
async function loginAs(sw: Worker, user: string) {
  await sw.evaluate(
    async ({ user, value }) => {
      const all = await chrome.cookies.getAll({ domain: 'facebook.com', partitionKey: {} });
      for (const c of all.filter((x) => x.name !== 'datr')) {
        await chrome.cookies.remove({
          url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
          name: c.name,
          ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
        });
      }
      const url = 'https://www.facebook.com/';
      const year = Date.now() / 1000 + 365 * 86400;
      const base = { url, path: '/', secure: true, httpOnly: false, sameSite: 'lax' as const };
      await chrome.cookies.set({
        ...base,
        name: 'c_user',
        value: user,
        domain: 'facebook.com',
        expirationDate: year,
      });
      await chrome.cookies.set({
        ...base,
        name: 'xs',
        value,
        domain: 'facebook.com',
        httpOnly: true,
        sameSite: 'no_restriction',
        expirationDate: year,
      });
      await chrome.cookies.set({ ...base, name: 'host_only', value: `h-${user}` });
      await chrome.cookies.set({
        ...base,
        name: 'chips',
        value: `c-${user}`,
        sameSite: 'no_restriction',
        partitionKey: { topLevelSite: 'https://instagram.com' },
      });
    },
    { user, value: secret(user) },
  );
}

async function facebookCookies(sw: Worker) {
  return sw.evaluate(async () =>
    (await chrome.cookies.getAll({ domain: 'facebook.com', partitionKey: {} }))
      .map(
        (c) =>
          `${c.name}=${c.value}${c.hostOnly ? ' host-only' : ''}${c.partitionKey ? ' partitioned' : ''}`,
      )
      .sort(),
  );
}

const send = (page: Page, message: unknown) =>
  page.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }>;

test('add two Facebook accounts and switch between them five times', async ({
  context,
  extensionId,
}) => {
  const sw = await worker(context);
  const swConsole: string[] = [];
  sw.on('console', (m) => swConsole.push(m.text()));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await sw.evaluate(() =>
    chrome.cookies.set({
      url: 'https://www.facebook.com/',
      name: 'datr',
      value: 'device',
      domain: 'facebook.com',
      path: '/',
      secure: true,
      sameSite: 'no_restriction',
    }),
  );
  expect(await send(page, { type: 'vault.setup', password: PASSWORD })).toEqual({ ok: true });
  await loginAs(sw, '1001');
  const alice = (await send(page, {
    type: 'account.addCurrent',
    platform: 'facebook',
    label: 'Alice',
  })) as { value: { id: string } };
  await loginAs(sw, '1002');
  const bob = (await send(page, {
    type: 'account.addCurrent',
    platform: 'facebook',
    label: 'Bob',
  })) as { value: { id: string } };
  expect(
    await send(page, { type: 'account.addCurrent', platform: 'facebook', label: 'Bob' }),
  ).toEqual({ ok: false, error: 'duplicate' });

  const expected = (user: string) => [
    `c_user=${user}`,
    `chips=c-${user} host-only partitioned`,
    'datr=device',
    `host_only=h-${user} host-only`,
    `xs=${secret(user)}`,
  ];
  for (let round = 0; round < 5; round += 1) {
    const [target, user] = round % 2 === 0 ? [alice, '1001'] : [bob, '1002'];
    expect(await send(page, { type: 'account.switch', accountId: target.value.id })).toEqual({
      ok: true,
      value: { reloadedTabs: 0 },
    });
    expect(await facebookCookies(sw)).toEqual(expected(user));
  }

  const state = (await send(page, { type: 'state.get' })) as {
    value: { active: { facebook: string }; locked: boolean; busy: string[] };
  };
  expect(state.value).toMatchObject({
    active: { facebook: alice.value.id },
    locked: false,
    busy: [],
  });

  // Nothing secret at rest outside the encrypted vault, and the journal is gone.
  const stored = await sw.evaluate(async () => ({
    local: JSON.stringify(await chrome.storage.local.get(null)),
    session: Object.keys(await chrome.storage.session.get(null)),
  }));
  expect(stored.local).not.toContain('SECRET');
  expect(stored.session).toEqual(['vaultKey']);
  expect(swConsole.filter((l) => l.includes('SECRET') || l.includes(PASSWORD))).toEqual([]);

  // Locked: switching asks for the password, and the right one opens it again.
  expect(await send(page, { type: 'vault.lock' })).toEqual({ ok: true });
  expect(await send(page, { type: 'account.switch', accountId: bob.value.id })).toEqual({
    ok: false,
    error: 'locked',
  });
  expect(await send(page, { type: 'vault.unlock', password: 'wrong password!' })).toEqual({
    ok: false,
    error: 'wrong_password',
  });
  expect(await send(page, { type: 'vault.unlock', password: PASSWORD })).toEqual({ ok: true });
  expect(await send(page, { type: 'account.switch', accountId: bob.value.id })).toMatchObject({
    ok: true,
  });
  expect(await facebookCookies(sw)).toEqual(expected('1002'));

  // A malformed message is refused by the real worker too.
  expect(await send(page, { type: 'vault.wipe', everything: true })).toEqual({
    ok: false,
    error: 'bad_request',
  });
});
