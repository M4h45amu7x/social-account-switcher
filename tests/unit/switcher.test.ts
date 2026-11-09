// docs/design.md 8.3 tests 5 and 6: switchAccount().
import { describe, expect, test } from 'bun:test';
import { journalKey, readJournal } from '../../src/background/journal';
import { switchAccount } from '../../src/background/switcher';
import { loadStore } from '../../src/lib/store';
import { loginAs, NOW, secretOf, whoIs, withAccounts } from '../fakes/harness';

const sw = (h: Awaited<ReturnType<typeof withAccounts>>['h'], id: string, force = false) =>
  switchAccount(h.deps, 'facebook', id, { force });

async function store(h: Awaited<ReturnType<typeof withAccounts>>['h']) {
  const s = await loadStore(h.chrome.storage.local);
  if (!s.ok) throw new Error(s.error);
  return s.value;
}

const value = (h: Awaited<ReturnType<typeof withAccounts>>['h'], name: string) =>
  h.chrome.cookies.all().find((c) => c.name === name)?.value;

describe('switchAccount: order and locking (test 5)', () => {
  test('snapshot → journal → save → clear → restore → reload → verify, then the journal goes', async () => {
    const { h, ids } = await withAccounts();
    const events: string[] = [];
    const log = (e: string) => {
      if (events.at(-1) !== e) events.push(e);
    };
    const c = h.chrome;
    const wrap =
      <A extends unknown[], R>(f: (...a: A) => R, e: string | ((...a: A) => string | null)) =>
      (...a: A) => {
        const name = typeof e === 'string' ? e : e(...a);
        if (name) log(name);
        return f(...a);
      };
    c.cookies.getAll = wrap(c.cookies.getAll, 'getAll');
    c.cookies.remove = wrap(c.cookies.remove, 'remove');
    c.cookies.set = wrap(c.cookies.set, 'set');
    c.tabs.reload = wrap(c.tabs.reload, 'reload');
    c.storage.local.set = wrap(c.storage.local.set, 'save');
    c.storage.session.set = wrap(c.storage.session.set, (items) =>
      journalKey('facebook') in items ? 'journal' : null,
    );
    c.storage.session.remove = wrap(c.storage.session.remove, (keys) =>
      [keys].flat().includes(journalKey('facebook')) ? 'journal-cleared' : null,
    );

    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: true, value: { reloadedTabs: 2 } });
    expect(events).toEqual([
      'getAll', // 1. snapshot
      'journal', // 2. journal, with the snapshot as its backup
      'save', // 3. Bob's latest session goes into the vault
      'getAll', // 4. clear: list
      'remove', //    clear: remove
      'getAll', //    clear: count what is left
      'set', // 5. restore Alice
      'reload', // 6. reload the Facebook tabs
      'getAll', // 7. verify
      'save', //    Alice active, status ok
      'journal-cleared', // 8.
    ]);
    expect(whoIs(c, 'facebook')).toBe('1001');
    expect(value(h, 'xs')).toBe(secretOf('1001'));
    expect((await store(h)).active.facebook).toBe(ids['1001'] ?? '');
  });

  test('device cookies, other platforms and other sites are left alone', async () => {
    const { h, ids } = await withAccounts();
    const before = h.chrome.cookies
      .all()
      .filter((c) => !c.domain.endsWith('facebook.com') || c.name === 'datr');
    await sw(h, ids['1001'] ?? '');
    const after = h.chrome.cookies
      .all()
      .filter((c) => !c.domain.endsWith('facebook.com') || c.name === 'datr');
    expect(after).toEqual(before);
    expect(h.chrome.tabs.reloaded).toEqual([1, 2]); // the two Facebook tabs, not Instagram or example.com
  });

  test('host-only and partitioned cookies come back as they were', async () => {
    const { h, ids } = await withAccounts();
    await sw(h, ids['1001'] ?? '');
    const all = h.chrome.cookies.all();
    expect(all.find((c) => c.name === 'host_only')).toMatchObject({
      hostOnly: true,
      value: 'h-1001',
    });
    expect(all.find((c) => c.name === 'chips')).toMatchObject({
      value: 'c-1001',
      partitionKey: { topLevelSite: 'https://instagram.com', hasCrossSiteAncestor: true },
    });
  });

  test('a second press while a switch runs gives busy; the first still finishes', async () => {
    const { h, ids } = await withAccounts();
    const first = sw(h, ids['1001'] ?? '');
    expect(await sw(h, ids['1002'] ?? '')).toEqual({ ok: false, error: 'busy' });
    expect(await first).toMatchObject({ ok: true });
    expect(h.deps.busy.size).toBe(0);
  });

  test("Facebook and Instagram switch at the same time without losing each other's changes", async () => {
    const { h, ids } = await withAccounts();
    const [fb, ig] = await Promise.all([
      sw(h, ids['1001'] ?? ''),
      switchAccount(h.deps, 'instagram', ids['2001'] ?? ''),
    ]);
    expect(fb.ok && ig.ok).toBe(true);
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
    expect(whoIs(h.chrome, 'instagram')).toBe('2001');
    const s = await store(h);
    expect(s.active).toMatchObject({ facebook: ids['1001'], instagram: ids['2001'] });
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    expect(await readJournal(h.deps.session, 'instagram')).toBeNull();
  });

  test('a crash while writing the journal leaves no journal and the cookies untouched', async () => {
    const { h, ids } = await withAccounts();
    const original = h.chrome.storage.session.set;
    h.chrome.storage.session.set = (items) =>
      journalKey('facebook') in items
        ? Promise.reject(new Error('worker stopped'))
        : original(items);
    await expect(sw(h, ids['1001'] ?? '')).rejects.toThrow('worker stopped');
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
    expect(h.deps.busy.size).toBe(0);
  });

  test('the session of the account we leave is saved first, so the latest one comes back', async () => {
    const { h, ids } = await withAccounts();
    // Bob's site rotated his session after he was added.
    await h.chrome.cookies.set({
      url: 'https://www.facebook.com/',
      name: 'xs',
      value: 'xs-rotated-1002',
      domain: 'facebook.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    });
    await sw(h, ids['1001'] ?? '');
    h.chrome.clock.now += 1000;
    await sw(h, ids['1002'] ?? '');
    expect(value(h, 'xs')).toBe('xs-rotated-1002');
    expect((await store(h)).accounts.find((a) => a.id === ids['1002'])?.sessionCapturedAt).toBe(
      NOW,
    );
  });

  test('an unsaved account in the browser gives unsaved_current unless forced', async () => {
    const { h, ids } = await withAccounts();
    await loginAs(h.chrome, 'facebook', '9999');
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'unsaved_current' });
    expect(whoIs(h.chrome, 'facebook')).toBe('9999');
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    expect(await sw(h, ids['1001'] ?? '', true)).toMatchObject({ ok: true });
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
  });

  test('nobody logged in is not "unsaved"', async () => {
    const { h, ids } = await withAccounts();
    await h.chrome.cookies
      .getAll({ domain: 'facebook.com', partitionKey: {} })
      .then(async (all) => {
        for (const c of all.filter((x) => x.name !== 'datr')) {
          await h.chrome.cookies.remove({
            url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
            name: c.name,
            ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
          });
        }
      });
    expect(whoIs(h.chrome, 'facebook')).toBeNull();
    expect(await sw(h, ids['1001'] ?? '')).toMatchObject({ ok: true });
  });

  test('locked, unknown account, or an account of another platform', async () => {
    const { h, ids } = await withAccounts();
    expect(await switchAccount(h.deps, 'facebook', ids['2001'] ?? '')).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await sw(h, 'nope')).toEqual({ ok: false, error: 'not_found' });
    await h.must({ type: 'vault.lock' });
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'locked' });
  });

  test('a store this version cannot read is reported, not overwritten', async () => {
    const { h, ids } = await withAccounts();
    await h.chrome.storage.local.set({ store: { schemaVersion: 9 } });
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'store_unreadable' });
    expect(h.chrome.storage.local.dump()).toEqual({ store: { schemaVersion: 9 } });
  });

  test('with no tab open the cookies are still checked', async () => {
    const { h, ids } = await withAccounts([]);
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: true, value: { reloadedTabs: 0 } });
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
  });

  test('a tab that never finishes loading does not hang the switch', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.tabs.finishLoading = false;
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: true, value: { reloadedTabs: 2 } });
  });

  test('a tab that fails to reload is not counted', async () => {
    const { h, ids } = await withAccounts();
    const original = h.chrome.tabs.reload;
    h.chrome.tabs.reload = (id) => (id === 2 ? Promise.reject(new Error('gone')) : original(id));
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: true, value: { reloadedTabs: 1 } });
  });
});

describe('switchAccount: failures put the previous account back (test 6)', () => {
  test('the server rejects the session: backup restored, account expired, tabs reloaded again', async () => {
    const { h, ids } = await withAccounts();
    // The fake site drops a revoked session when the page loads.
    h.chrome.tabs.onLoad = async () => {
      if (whoIs(h.chrome, 'facebook') === '1001') {
        await h.chrome.cookies.remove({ url: 'https://facebook.com/', name: 'c_user' });
      }
    };
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'expired' });
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
    expect(value(h, 'xs')).toBe(secretOf('1002'));
    const s = await store(h);
    expect(s.accounts.find((a) => a.id === ids['1001'])?.status).toBe('expired');
    expect(s.active.facebook).toBe(ids['1002'] ?? '');
    expect(h.chrome.tabs.reloaded).toEqual([1, 2, 1, 2]);
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    expect(h.deps.busy.size).toBe(0);
  });

  test('another user shows up after the load: also a mismatch', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.tabs.onLoad = () => loginAs(h.chrome, 'facebook', '5555');
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'expired' });
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
  });

  test('a checkpoint page counts as switched but reports checkpoint', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.tabs.onLoad = (tab) => {
      tab.url = 'https://www.facebook.com/checkpoint/828281030927956/';
    };
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'checkpoint' });
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
    const s = await store(h);
    expect(s.accounts.find((a) => a.id === ids['1001'])).toMatchObject({
      status: 'checkpoint',
      lastUsedAt: NOW,
    });
    expect(s.active.facebook).toBe(ids['1001'] ?? '');
    expect(h.deps.busy.size).toBe(0);
  });

  test('a saved session that has fully expired fails before anything changes', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.clock.now += 2 * 365 * 86400 * 1000;
    await loginAs(h.chrome, 'facebook', '1002'); // Bob is still fresh in the browser
    expect(await sw(h, ids['1001'] ?? '')).toEqual({ ok: false, error: 'expired' });
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
    expect((await store(h)).accounts.find((a) => a.id === ids['1001'])?.status).toBe('expired');
  });

  test('an account with no saved session is expired', async () => {
    const { h, ids } = await withAccounts();
    const s = await store(h);
    await h.chrome.storage.local.set({
      store: {
        ...s,
        accounts: [...s.accounts, { ...s.accounts[0], id: 'no-session', platformUserId: '7' }],
      },
    });
    expect(await sw(h, 'no-session')).toEqual({ ok: false, error: 'expired' });
    expect(ids).toBeDefined();
  });

  test('cookies that expire during the switch: backup restored', async () => {
    const { h } = await withAccounts();
    await loginAs(h.chrome, 'facebook', '3003', true); // every cookie of Carol has an expiry date
    const carol = await h.must<{ id: string }>({
      type: 'account.addCurrent',
      platform: 'facebook',
      label: 'Carol',
    });
    await loginAs(h.chrome, 'facebook', '1002');
    // The clock jumps two years once the session of the account we leave is saved, so the
    // pre-check passes and restore() finds every one of Carol's cookies expired.
    const save = h.chrome.storage.local.set;
    h.chrome.storage.local.set = async (items) => {
      await save(items);
      h.chrome.clock.now = NOW + 2 * 365 * 86400 * 1000;
    };
    expect(await sw(h, carol.id)).toEqual({ ok: false, error: 'expired' });
    // Bob's dated cookies have expired by then too; his session cookies are back.
    expect(value(h, 'presence')).toBe('p-1002');
    expect(value(h, 'xs')).toBeUndefined();
    expect((await store(h)).accounts.find((a) => a.id === carol.id)?.status).toBe('expired');
    expect(h.chrome.tabs.reloaded).toEqual([]);
  });

  test('an exception mid-switch puts the backup back, clears the journal and frees the lock', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.tabs.query = () => Promise.reject(new Error('tabs broke'));
    await expect(sw(h, ids['1001'] ?? '')).rejects.toThrow('tabs broke');
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
    expect(value(h, 'xs')).toBe(secretOf('1002'));
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    expect(h.deps.busy.size).toBe(0);
  });

  test('if putting the backup back fails too, the journal stays for recovery', async () => {
    const { h, ids } = await withAccounts();
    h.chrome.tabs.query = () => Promise.reject(new Error('tabs broke'));
    const getAll = h.chrome.cookies.getAll;
    let calls = 0;
    h.chrome.cookies.getAll = (d) =>
      ++calls > 4 ? Promise.reject(new Error('cookies broke')) : getAll(d);
    await expect(sw(h, ids['1001'] ?? '')).rejects.toThrow('cookies broke');
    expect(await readJournal(h.deps.session, 'facebook')).not.toBeNull();
    expect(h.deps.busy.size).toBe(0);
  });
});
