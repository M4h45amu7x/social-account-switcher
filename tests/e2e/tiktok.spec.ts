import { expect, test } from '@playwright/test';
import { TIKTOK_EXPERIMENT } from '../../src/background/platforms/tiktok';
import { TT, TT_OTHER } from './fake-tiktok';
import { buildTikTok } from './tiktok-build';
import {
  cookies,
  launchTikTok,
  login,
  PASSWORD,
  saved,
  send,
  setupPair,
  type TestHooks,
  tokenOf,
  worker,
} from './tiktok-helpers';

test.beforeAll(buildTikTok);

test('TikTok: five alternating switches resnapshot rotated target and departing sessions; attributes and devices survive', async () => {
  test.setTimeout(120_000);
  const h = await launchTikTok();
  try {
    const ids = await setupPair(h);
    const preserved = (await cookies(h.sw)).filter((c) =>
      TIKTOK_EXPERIMENT.preservedCookieNames.includes(c.name),
    );
    expect(preserved).toHaveLength(TIKTOK_EXPERIMENT.preservedCookieNames.length + 1);
    for (let round = 0; round < 6; round++) {
      const user = round % 2 === 0 ? 'alice' : 'bob';
      const from = round % 2 === 0 ? 'bob' : 'alice';
      await h.tab.goto(`https://${TT}/video/${round}`);
      const before = tokenOf(await cookies(h.sw));
      expect(h.fake.valid(before, from)).toBe(true);
      const targetBefore = tokenOf((await saved(h.sw))[ids[user]]?.cookies ?? []);
      await h.sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.clearWrites());
      expect(await send(h.popup, { type: 'account.switch', accountId: ids[user] })).toEqual({
        ok: true,
        value: { reloadedTabs: 1 },
      });
      await expect(h.tab.locator('#who')).toHaveAttribute('data-user', user);
      const now = await cookies(h.sw);
      const current = tokenOf(now);
      expect(current).not.toBe(targetBefore);
      expect(h.fake.valid(current, user)).toBe(true);
      const restored = await h.sw.evaluate(
        () => (globalThis as unknown as TestHooks).__tiktokTest.writes,
      );
      expect(restored.find((c) => c.name === 'companion_unknown')).toMatchObject({
        hostOnly: true,
        domain: TT,
        httpOnly: true,
        sameSite: 'strict',
      });
      expect(restored.find((c) => c.name === 'partition_session')).toMatchObject({
        hostOnly: true,
        domain: TT,
        partitionKey: { topLevelSite: 'https://tiktok.com', hasCrossSiteAncestor: false },
      });
      expect(restored.some((c) => TIKTOK_EXPERIMENT.preservedCookieNames.includes(c.name))).toBe(
        false,
      );
      const sessions = await saved(h.sw);
      expect(tokenOf(sessions[ids[user]]?.cookies ?? [])).toBe(current);
      expect(tokenOf(sessions[ids[from]]?.cookies ?? [])).toBe(before);
      expect(now.filter((c) => TIKTOK_EXPERIMENT.preservedCookieNames.includes(c.name))).toEqual(
        preserved,
      );
      expect(now.find((c) => c.name === 'companion_unknown')).toMatchObject({
        hostOnly: true,
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        session: true,
      });
      expect(now.find((c) => c.name === 'partition_session')).toMatchObject({
        hostOnly: true,
        partitionKey: { topLevelSite: 'https://tiktok.com' },
        sameSite: 'no_restriction',
        secure: true,
      });
    }
    expect(h.fake.rejected).toEqual([]);
  } finally {
    await h.close();
  }
});

test('TikTok: reload all TikTok tabs, leave unrelated tabs; no independent extension requests', async () => {
  const h = await launchTikTok();
  try {
    const { alice } = await setupPair(h);
    const more = await h.context.newPage();
    await more.goto(`https://${TT}/following`);
    const unrelated = await h.context.newPage();
    await unrelated.goto(`https://${TT_OTHER}/news`);
    await unrelated.evaluate(() => {
      document.body.dataset.mark = 'untouched';
    });
    await more.evaluate(() => {
      document.body.dataset.mark = 'reload-me';
    });
    await h.tab.bringToFront();
    const traffic: string[] = [];
    h.context.on('request', (r) => {
      if (r.serviceWorker() || r.frame().url().startsWith('chrome-extension:'))
        traffic.push(r.url());
    });
    const before = new Map(h.fake.loads);
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toEqual({
      ok: true,
      value: { reloadedTabs: 2 },
    });
    await expect(more.locator('#who')).toHaveAttribute('data-user', 'alice');
    expect(await more.evaluate(() => document.body.dataset.mark)).toBeUndefined();
    expect(await unrelated.evaluate(() => document.body.dataset.mark)).toBe('untouched');
    expect(h.fake.loads.get(`${TT_OTHER}/news`)).toBe(before.get(`${TT_OTHER}/news`));
    expect(h.fake.loads.get(`${TT}/following`)).toBe((before.get(`${TT}/following`) ?? 0) + 1);
    expect(traffic.filter((u) => !u.startsWith(`chrome-extension://${h.extensionId}/`))).toEqual(
      [],
    );
    expect([...h.sites.hostsSeen].sort()).toEqual([TT_OTHER, TT].sort());
  } finally {
    await h.close();
  }
});

test('TikTok: viewer traps, unknown/malformed state, explicit logout, no-tab and denied host are distinct', async () => {
  const h = await launchTikTok();
  try {
    const { bob } = await setupPair(h);
    expect(
      await send(h.popup, { type: 'account.probe', platform: 'tiktok', tabId: h.tabId }),
    ).toEqual({
      ok: true,
      value: {
        tail: '0002',
        accountId: bob,
        profile: {
          displayName: 'bob Profile',
          handle: 'bob',
          avatar: expect.stringMatching(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
        },
      },
    });
    for (const mode of ['missing', 'malformed'] as const) {
      h.fake.modes.set('bob', mode);
      await h.tab.reload();
      expect(
        await send(h.popup, { type: 'account.probe', platform: 'tiktok', tabId: h.tabId }),
      ).toEqual({ ok: false, error: 'tiktok_probe_unavailable' });
    }
    h.fake.modes.set('bob', 'logout');
    await h.tab.reload();
    expect(
      await send(h.popup, { type: 'account.probe', platform: 'tiktok', tabId: h.tabId }),
    ).toEqual({ ok: true, value: { tail: null, accountId: null } });
    expect(await send(h.popup, { type: 'account.probe', platform: 'tiktok' })).toEqual({
      ok: false,
      error: 'no_tiktok_tab',
    });
    await h.tab.goto(`https://${TT_OTHER}/`);
    expect(
      await send(h.popup, { type: 'account.probe', platform: 'tiktok', tabId: h.tabId }),
    ).toEqual({ ok: false, error: 'no_tiktok_tab' });
    await h.tab.close();
    expect(
      await send(h.popup, { type: 'account.probe', platform: 'tiktok', tabId: h.tabId }),
    ).toEqual({ ok: false, error: 'no_tiktok_tab' });
    // The real scripting host permission also refuses an unrelated host, independently of the reader.
    const other = await h.sw.evaluate(
      async () => (await chrome.tabs.create({ url: 'https://news.example.org/' })).id,
    );
    expect(
      await h.sw.evaluate(async (id) => {
        try {
          await chrome.scripting.executeScript({ target: { tabId: id as number }, func: () => 1 });
          return false;
        } catch {
          return true;
        }
      }, other),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

test('TikTok: revoked target rolls back a valid backup; invalid backup retains journal and reports recovery failure', async () => {
  const h = await launchTikTok();
  try {
    const { alice, bob } = await setupPair(h);
    h.fake.revoke('alice');
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toEqual({
      ok: false,
      error: 'expired',
    });
    await expect(h.tab.locator('#who')).toHaveAttribute('data-user', 'bob');
    expect(h.fake.valid(tokenOf(await cookies(h.sw)), 'bob')).toBe(true);
    expect(await h.sw.evaluate(() => chrome.storage.session.get('journal.tiktok'))).toEqual({});
    // Refresh Alice's saved session, return to Bob, then revoke both server-side while Bob's DOM remains.
    await login(h, 'alice');
    expect(
      await send(h.popup, { type: 'account.updateSession', accountId: alice, tabId: h.tabId }),
    ).toEqual({ ok: true });
    await login(h, 'bob');
    expect(
      await send(h.popup, { type: 'account.updateSession', accountId: bob, tabId: h.tabId }),
    ).toEqual({ ok: true });
    h.fake.revoke('alice');
    h.fake.revoke('bob');
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toEqual({
      ok: false,
      error: 'rollback_failed',
    });
    expect(await h.sw.evaluate(() => chrome.storage.session.get('journal.tiktok'))).toHaveProperty([
      'journal.tiktok',
    ]);
    expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toEqual({
      ok: false,
      error: 'rollback_failed',
    });
    const cdp = await h.context.newCDPSession(h.popup);
    const versions = new Map<string, string>();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const v of event.versions as {
        versionId: string;
        scriptURL: string;
        runningStatus: string;
      }[])
        if (v.scriptURL.includes(h.extensionId)) versions.set(v.versionId, v.runningStatus);
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versions.size).toBeGreaterThan(0);
    for (const versionId of versions.keys())
      await cdp.send('ServiceWorker.stopWorker', { versionId });
    await expect.poll(() => [...versions.values()].every((v) => v === 'stopped')).toBe(true);
    await send(h.popup, { type: 'state.get' });
    const restarted = await worker(h.context);
    expect(
      await restarted.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.ready),
    ).toEqual({ rolledBack: [], waiting: ['tiktok'], dropped: [] });
    expect(
      await restarted.evaluate(() => chrome.storage.session.get('journal.tiktok')),
    ).toHaveProperty(['journal.tiktok']);
    await cdp.detach();
  } finally {
    await h.close();
  }
});

test('TikTok: checkpoint and captcha remain manual; busy, duplicate and password gates work', async () => {
  const h = await launchTikTok();
  try {
    const { alice, bob } = await setupPair(h);
    expect(
      await send(h.popup, {
        type: 'account.addCurrent',
        platform: 'tiktok',
        label: 'duplicate',
        tabId: h.tabId,
      }),
    ).toEqual({ ok: false, error: 'duplicate' });
    await h.sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.hold());
    const switching = send(h.popup, { type: 'account.switch', accountId: alice });
    await expect
      .poll(() => h.sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.held))
      .toBe(true);
    expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toEqual({
      ok: false,
      error: 'busy',
    });
    await h.sw.evaluate(() => (globalThis as unknown as TestHooks).__tiktokTest.release());
    expect(await switching).toMatchObject({ ok: true });
    for (const mode of ['checkpoint', 'captcha'] as const) {
      h.fake.modes.set('bob', mode);
      expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toEqual({
        ok: false,
        error: 'checkpoint',
      });
      await expect(h.tab.locator('#manual')).toContainText(
        mode === 'captcha' ? 'captcha yourself' : 'Verify your identity',
      );
      const state = await send(h.popup, { type: 'state.get' });
      expect(state.value).toMatchObject({
        accounts: expect.arrayContaining([
          expect.objectContaining({ id: bob, status: 'checkpoint' }),
        ]),
      });
      h.fake.modes.delete('bob');
      await h.tab.reload();
      // Update the session after the manual step so its current generation remains reusable.
      expect(
        await send(h.popup, { type: 'account.updateSession', accountId: bob, tabId: h.tabId }),
      ).toEqual({ ok: true });
      expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toMatchObject({
        ok: true,
      });
    }
    expect(await send(h.popup, { type: 'vault.lock' })).toEqual({ ok: true });
    expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toEqual({
      ok: false,
      error: 'locked',
    });
    expect(await send(h.popup, { type: 'vault.unlock', password: 'wrong password!' })).toEqual({
      ok: false,
      error: 'wrong_password',
    });
    expect(await send(h.popup, { type: 'vault.unlock', password: PASSWORD })).toEqual({ ok: true });
    expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toMatchObject({
      ok: true,
    });
  } finally {
    await h.close();
  }
});

test('TikTok: unknown switch state rolls back without an expiry claim; no active TikTok tab cannot switch', async () => {
  const h = await launchTikTok();
  try {
    const { alice, bob } = await setupPair(h);
    h.fake.modes.set('alice', 'missing');
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toEqual({
      ok: false,
      error: 'tiktok_probe_unavailable',
    });
    await expect(h.tab.locator('#who')).toHaveAttribute('data-user', 'bob');
    expect(await send(h.popup, { type: 'state.get' })).toMatchObject({
      value: {
        active: { tiktok: bob },
        accounts: expect.arrayContaining([expect.objectContaining({ id: alice, status: 'ok' })]),
      },
    });
    const before = await cookies(h.sw);
    await h.tab.goto(`https://${TT_OTHER}/`);
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toEqual({
      ok: false,
      error: 'no_tiktok_tab',
    });
    expect(await cookies(h.sw)).toEqual(before);
  } finally {
    await h.close();
  }
});

test('TikTok: three concurrent reloads with a delayed response save the final generation and reuse it after grace', async () => {
  const h = await launchTikTok();
  try {
    const { alice, bob } = await setupPair(h);
    const more = await h.context.newPage();
    await more.goto(`https://${TT}/following`);
    const slow = await h.context.newPage();
    await slow.goto(`https://${TT}/slow`);
    await h.tab.bringToFront();
    h.fake.delays.set('/slow', 500);
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toEqual({
      ok: true,
      value: { reloadedTabs: 3 },
    });
    for (const page of [h.tab, more, slow])
      await expect(page.locator('#who')).toHaveAttribute('data-user', 'alice');
    const finalToken = tokenOf(await cookies(h.sw));
    const savedToken = tokenOf((await saved(h.sw))[alice]?.cookies ?? []);
    expect(savedToken).toBe(finalToken);
    h.fake.advance(1001);
    expect(h.fake.valid(savedToken, 'alice')).toBe(true);
    expect(h.fake.rejected).toEqual([]);
    h.fake.delays.clear();
    expect(await send(h.popup, { type: 'account.switch', accountId: bob })).toMatchObject({
      ok: true,
    });
    h.fake.advance(1001);
    expect(await send(h.popup, { type: 'account.switch', accountId: alice })).toMatchObject({
      ok: true,
    });
    for (const page of [h.tab, more, slow])
      await expect(page.locator('#who')).toHaveAttribute('data-user', 'alice');
  } finally {
    await h.close();
  }
});
