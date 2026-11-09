// docs/design.md 8.3 test 7: a switch the worker never finished is rolled back on the next start.
import { describe, expect, test } from 'bun:test';
import {
  clearJournal,
  journalKey,
  readJournal,
  recoverJournal,
  writeJournal,
} from '../../src/background/journal';
import { getKey } from '../../src/background/keyring';
import { COOKIE_PLATFORMS } from '../../src/background/platforms';
import { snapshot } from '../../src/lib/cookies';
import { sealCookies } from '../../src/lib/vault';
import { loginAs, PASSWORD, secretOf, whoIs, withAccounts } from '../fakes/harness';

/** Leaves the browser half-way: Bob's cookies saved in a journal, Alice's cookies in the browser. */
async function crashMidSwitch() {
  const { h, ids } = await withAccounts();
  const key = await getKey(h.deps.session);
  if (!key) throw new Error('locked');
  const bob = await snapshot(h.deps.cookies, COOKIE_PLATFORMS.facebook);
  await writeJournal(h.deps.session, {
    platform: 'facebook',
    fromId: ids['1002'] ?? null,
    toId: ids['1001'] ?? '',
    backup: await sealCookies(key, bob),
    startedAt: 1,
  });
  await loginAs(h.chrome, 'facebook', '1001');
  return { h, ids };
}

describe('journal recovery (test 7)', () => {
  test('a new worker finds the journal, puts the backup back, reloads tabs and clears it', async () => {
    const { h } = await crashMidSwitch();
    h.chrome.tabs.reloaded.length = 0;
    const next = await h.restartWorker();
    expect(await next.router.ready).toEqual({ rolledBack: ['facebook'], waiting: [], dropped: [] });
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
    expect(h.chrome.cookies.all().find((c) => c.name === 'xs')?.value).toBe(secretOf('1002'));
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    expect(h.chrome.tabs.reloaded).toEqual([1, 2]);
  });

  test('recovery holds the platform while it rolls back, then lets it go', async () => {
    const { h } = await crashMidSwitch();
    const seen: boolean[] = [];
    const set = h.deps.cookies.set.bind(h.deps.cookies);
    h.deps.cookies.set = (cookie) => {
      seen.push(h.deps.busy.has('facebook'));
      return set(cookie);
    };
    expect((await recoverJournal(h.deps)).rolledBack).toEqual(['facebook']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(h.deps.busy.size).toBe(0);
  });

  test('a real switch stopped at the reload step is rolled back', async () => {
    const { h, ids } = await withAccounts();
    const reload = h.chrome.tabs.reload;
    h.chrome.tabs.reload = () => new Promise(() => {}); // the worker is stopped here
    const stuck = h.send({ type: 'account.switch', accountId: ids['1001'] }); // never settles
    expect(stuck).toBeInstanceOf(Promise);
    await new Promise((r) => setTimeout(r, 20));
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
    expect(await readJournal(h.deps.session, 'facebook')).not.toBeNull();
    h.chrome.tabs.reload = reload; // the new worker's Chrome works again
    const next = await h.restartWorker();
    expect((await next.router.ready)?.rolledBack).toEqual(['facebook']);
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
  });

  test('locked at start: the journal waits, and the next unlock rolls it back', async () => {
    const { h } = await crashMidSwitch();
    await h.deps.session.remove('vaultKey'); // Chrome restarted? then the journal would be gone too; this is a lock
    const next = await h.restartWorker();
    expect(await next.router.ready).toEqual({ rolledBack: [], waiting: ['facebook'], dropped: [] });
    expect(whoIs(h.chrome, 'facebook')).toBe('1001');
    await next.must({ type: 'vault.unlock', password: PASSWORD });
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
  });

  test('a backup that cannot be decrypted is dropped, not retried for ever', async () => {
    const { h } = await crashMidSwitch();
    const j = await readJournal(h.deps.session, 'facebook');
    await h.deps.session.set({ [journalKey('facebook')]: { ...j, backup: 'AAAA' } });
    const next = await h.restartWorker();
    expect(await next.router.ready).toEqual({ rolledBack: [], waiting: [], dropped: ['facebook'] });
    expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
  });

  test('a platform with a switch running in this worker is skipped', async () => {
    const { h } = await crashMidSwitch();
    h.deps.busy.add('facebook');
    expect(await recoverJournal(h.deps)).toEqual({ rolledBack: [], waiting: [], dropped: [] });
    expect(await readJournal(h.deps.session, 'facebook')).not.toBeNull();
  });

  test('malformed journal entries count as none', async () => {
    const { h } = await withAccounts();
    for (const bad of [
      null,
      'x',
      { platform: 'instagram', toId: 'a', backup: 'b', startedAt: 1, fromId: null },
      { platform: 'facebook', fromId: 3 },
    ]) {
      await h.deps.session.set({ [journalKey('facebook')]: bad });
      expect(await readJournal(h.deps.session, 'facebook')).toBeNull();
    }
    await clearJournal(h.deps.session, 'facebook');
    expect(h.chrome.storage.session.dump()).not.toHaveProperty(journalKey('facebook'));
  });

  test('a failed recovery is logged without details and retried later', async () => {
    const { h } = await crashMidSwitch();
    const getAll = h.chrome.cookies.getAll;
    h.chrome.cookies.getAll = () => Promise.reject(new Error(`boom ${secretOf('1002')}`));
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => lines.push(a.map(String).join(' '));
    try {
      const next = await h.restartWorker();
      expect(await next.router.ready).toBeNull();
    } finally {
      console.error = original;
    }
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(lines).toHaveLength(1);
    h.chrome.cookies.getAll = getAll;
    expect((await recoverJournal(h.deps)).rolledBack).toEqual(['facebook']);
  });

  test('a tab that fails to reload does not stop the rollback', async () => {
    const { h } = await crashMidSwitch();
    h.chrome.tabs.reload = () => Promise.reject(new Error('tab closed'));
    expect((await recoverJournal(h.deps)).rolledBack).toEqual(['facebook']);
    expect(whoIs(h.chrome, 'facebook')).toBe('1002');
  });

  test('the journal backup holds no plain cookie', async () => {
    const { h } = await crashMidSwitch();
    expect(JSON.stringify(h.chrome.storage.session.dump())).not.toContain('SECRET');
  });
});
