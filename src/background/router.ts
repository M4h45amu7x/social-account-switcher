// Answers the popup's messages (docs/design.md 2, 6 and 8.2). Every message is checked for its sender
// and shape first, and every answer is a Result: nothing is thrown back across the message channel.
import { currentUserId, snapshot } from '../lib/cookies';
import { type ErrorCode, isTrustedSender, parseRequest, type Request } from '../lib/messages';
import type { MessageSender } from '../lib/ports';
import { err, ok, type Result } from '../lib/result';
import {
  type Account,
  addAccount,
  findAccount,
  loadStore,
  type Platform,
  removeAccount,
  renameAccount,
  STORE_KEY,
  type StoreV1,
  saveStore,
  setActive,
  updateAccount,
  updateSettings,
} from '../lib/store';
import { createVault, readVault, unlock, validatePassword, writeVault } from '../lib/vault';
import { holdPlatform } from './busy';
import { journalKey, type RecoverReport, recoverJournal } from './journal';
import { getKey, lock, storeKey } from './keyring';
import { isCookiePlatform } from './platforms';
import type { CookiePlatformId, YouTubeSession, YoutubeSwitcher } from './platforms/types';
import { editStore, patchStore, readStore } from './store-access';
import { type SwitchDeps, switchAccount } from './switcher';

export interface RouterDeps extends SwitchDeps {
  extensionId: string;
  youtube: YoutubeSwitcher;
  newId(): string;
}

/** What the popup gets from state.get. Never contains cookies or keys. */
export interface PopupState {
  accounts: Account[];
  active: StoreV1['active'];
  settings: StoreV1['settings'];
  hasVault: boolean;
  locked: boolean;
  busy: Platform[];
  /** Saved accounts that failed validation and are kept aside (see StoreV1.quarantine). */
  quarantined: number;
  /** When the next unlock attempt is allowed, after too many wrong passwords. */
  unlockRetryAt: number | null;
}

/** Design 6, point 5: after this many wrong passwords, each attempt waits UNLOCK_DELAY_MS. */
export const FREE_UNLOCK_ATTEMPTS = 5;
export const UNLOCK_DELAY_MS = 30_000;
const FAILURES_KEY = 'unlockFailures';

export interface Router {
  /** Settles when journal recovery at start-up has finished. Messages wait for it. */
  ready: Promise<RecoverReport | null>;
  handle(message: unknown, sender: MessageSender): Promise<Result<unknown, ErrorCode>>;
}

export function createRouter(deps: RouterDeps): Router {
  const recover = () =>
    recoverJournal(deps).catch(() => {
      // Never log the error itself: it could carry cookie data. The journal stays for the next try.
      console.error('Switch recovery failed; it will be retried');
      return null;
    });
  const ready = recover();

  async function handle(message: unknown, sender: MessageSender) {
    // Every path answers with a Result (design 8.2), even a message that throws while it is read.
    let type = 'unknown';
    try {
      if (!isTrustedSender(sender, deps.extensionId)) return err('forbidden');
      const request = parseRequest(message);
      if (!request.ok) return request;
      type = request.value.type;
      await ready;
      return await dispatch(deps, request.value, recover);
    } catch {
      console.error(`Request ${type} failed`);
      return err('internal');
    }
  }

  return { ready, handle };
}

function dispatch(
  deps: RouterDeps,
  request: Request,
  recover: () => Promise<RecoverReport | null>,
): Promise<Result<unknown, ErrorCode>> {
  switch (request.type) {
    case 'state.get':
      return getState(deps);
    case 'vault.setup':
      return setupVault(deps, request.password);
    case 'vault.unlock':
      return unlockVault(deps, request.password, recover);
    case 'vault.lock':
      return lock(deps.session).then(() => ok(undefined));
    case 'vault.wipe':
      return wipe(deps, request.scope ?? 'all');
    case 'settings.set':
      return patchStore(deps, (store) =>
        updateSettings(store, { theme: request.theme, language: request.language }),
      );
    case 'account.probe':
      return probe(deps, request.platform);
    case 'account.addCurrent':
      return addCurrent(deps, request.platform, request.label);
    case 'account.updateSession':
      return updateSession(deps, request.accountId);
    case 'account.rename':
      return patchStore(deps, (store) => renameAccount(store, request.accountId, request.label));
    case 'account.remove':
      return remove(deps, request.accountId);
    case 'account.switch':
      return switchTo(deps, request.accountId, request.force === true);
  }
}

async function getState(deps: RouterDeps): Promise<Result<PopupState, ErrorCode>> {
  const loaded = await readStore(deps);
  if (!loaded.ok) return loaded;
  const store = loaded.value;
  const failures = await readFailures(deps);
  return ok({
    accounts: store.accounts,
    active: store.active,
    settings: store.settings,
    hasVault: store.vault !== null,
    locked: (await getKey(deps.session)) === null,
    busy: [...deps.busy],
    quarantined: store.quarantine?.length ?? 0,
    unlockRetryAt: retryAt(failures),
  });
}

// --- vault ---

async function setupVault(deps: RouterDeps, password: string) {
  const valid = validatePassword(password);
  if (!valid.ok) return valid;
  let rawKey = '';
  const created = await editStore(deps, async (store) => {
    if (store.vault) return err('vault_exists');
    const made = await createVault(password, {});
    rawKey = made.rawKeyB64;
    return ok({ store: { ...store, vault: made.vault }, value: undefined });
  });
  if (created.ok) await storeKey(deps.session, rawKey);
  return created;
}

interface Failures {
  count: number;
  lastAt: number;
}

async function readFailures(deps: RouterDeps): Promise<Failures> {
  const raw = (await deps.session.get(FAILURES_KEY))[FAILURES_KEY] as Partial<Failures> | undefined;
  return { count: Number(raw?.count) || 0, lastAt: Number(raw?.lastAt) || 0 };
}

const retryAt = (f: Failures): number | null =>
  f.count >= FREE_UNLOCK_ATTEMPTS ? f.lastAt + UNLOCK_DELAY_MS : null;

async function unlockVault(
  deps: RouterDeps,
  password: string,
  recover: () => Promise<RecoverReport | null>,
) {
  const failures = await readFailures(deps);
  const until = retryAt(failures);
  if (until !== null && deps.now() < until) return err('too_many_attempts');
  const loaded = await readStore(deps);
  if (!loaded.ok) return loaded;
  if (!loaded.value.vault) return err('no_vault');
  const opened = await unlock(password, loaded.value.vault);
  if (!opened.ok) {
    if (opened.error === 'wrong_password') {
      await deps.session.set({ [FAILURES_KEY]: { count: failures.count + 1, lastAt: deps.now() } });
    }
    return opened;
  }
  await deps.session.remove(FAILURES_KEY);
  await storeKey(deps.session, opened.value);
  // A switch that died while the vault was locked can be rolled back now.
  await recover();
  return ok(undefined);
}

async function wipe(deps: RouterDeps, scope: 'sessions' | 'all') {
  if (deps.busy.size > 0) return err('busy');
  await deps.storeMutex.run(async () => {
    await lock(deps.session);
    if (scope === 'sessions') await dropSessions(deps);
    else await deps.local.remove(STORE_KEY);
    await deps.session.remove([
      FAILURES_KEY,
      ...Object.values(deps.platforms).map((p) => journalKey(p.id)),
    ]);
  });
  return ok(undefined);
}

/** Forgot-password wipe: the vault and every Facebook/Instagram account go; YouTube shortcuts hold no session and stay. */
async function dropSessions(deps: RouterDeps): Promise<void> {
  const loaded = await loadStore(deps.local);
  // An unreadable store can't be edited safely, so it is wiped whole (the user asked to start over).
  if (!loaded.ok) return deps.local.remove(STORE_KEY);
  const store = loaded.value;
  await saveStore(deps.local, {
    ...store,
    vault: null,
    accounts: store.accounts.filter((a) => a.platform === 'youtube'),
    active: { facebook: null, instagram: null, youtube: store.active.youtube },
  });
}

// --- accounts ---

/** Who is logged in now. `tail` is the last four characters of the ID (YouTube: the Google account number). */
async function probe(deps: RouterDeps, platform: Platform) {
  if (platform === 'youtube') {
    const current = await deps.youtube.readCurrent();
    if (!current.ok) return current.error === 'not_signed_in' ? ok({ tail: null }) : current;
    return ok({
      tail: String(current.value.authuser + 1),
      brand: current.value.pageid !== undefined,
    });
  }
  const userId = await currentUserId(deps.cookies, deps.platforms[platform]);
  return ok({ tail: userId === null ? null : userId.slice(-4) });
}

async function addCurrent(deps: RouterDeps, platform: Platform, label: string) {
  // Held like a switch, so what is read here can't change half-way through.
  if (platform === 'youtube')
    return holdPlatform(deps.busy, platform, () => addYoutube(deps, label));
  return holdPlatform(deps.busy, platform, () => addCookieAccount(deps, platform, label));
}

async function addYoutube(deps: RouterDeps, label: string) {
  const current = await deps.youtube.readCurrent();
  if (!current.ok) return current;
  return editStore(deps, async (store) => {
    const youtube = copySession(current.value);
    const added = addAccount(store, { platform: 'youtube', label, youtube }, ids(deps));
    if (!added.ok) return added;
    const active = setActive(added.value.store, 'youtube', added.value.account.id);
    return ok({
      store: active.ok ? active.value : added.value.store,
      value: added.value.account,
    });
  });
}

/** Only the two allow-listed fields go into the store. */
const copySession = (s: YouTubeSession) =>
  s.pageid === undefined ? { authuser: s.authuser } : { authuser: s.authuser, pageid: s.pageid };

async function addCookieAccount(deps: RouterDeps, platform: CookiePlatformId, label: string) {
  const p = deps.platforms[platform];
  const key = await getKey(deps.session);
  const userId = await currentUserId(deps.cookies, p);
  if (userId === null) return err('not_logged_in');
  const cookies = await snapshot(deps.cookies, p);
  const now = deps.now();
  return editStore(deps, async (store) => {
    if (!store.vault) return err('no_vault');
    if (!key) return err('locked');
    const added = addAccount(store, { platform, label, platformUserId: userId }, ids(deps));
    if (!added.ok) return added;
    const id = added.value.account.id;
    const sessions = await readVault(key, store.vault);
    sessions[id] = { capturedAt: now, cookies };
    const vault = await writeVault(key, store.vault, sessions);
    const account: Account = { ...added.value.account, sessionCapturedAt: now };
    const next: StoreV1 = {
      ...added.value.store,
      vault,
      accounts: added.value.store.accounts.map((a) => (a.id === id ? account : a)),
      active: { ...added.value.store.active, [platform]: id },
    };
    return ok({ store: next, value: account });
  });
}

const ids = (deps: RouterDeps) => ({ id: deps.newId(), now: deps.now() });

async function updateSession(deps: RouterDeps, accountId: string) {
  const loaded = await readStore(deps);
  if (!loaded.ok) return loaded;
  const account = findAccount(loaded.value, accountId);
  if (!account) return err('not_found');
  if (account.platform === 'youtube') {
    return holdPlatform(deps.busy, 'youtube', () => updateYoutube(deps, accountId));
  }
  if (deps.busy.has(account.platform)) return err('busy');
  const p = deps.platforms[account.platform];
  const key = await getKey(deps.session);
  if (!key) return err('locked');
  const userId = await currentUserId(deps.cookies, p);
  if (userId === null) return err('not_logged_in');
  if (userId !== account.platformUserId) return err('wrong_account');
  const cookies = await snapshot(deps.cookies, p);
  const now = deps.now();
  return editStore(deps, async (store) => {
    if (!store.vault || !findAccount(store, accountId)) return err('not_found');
    const sessions = await readVault(key, store.vault);
    sessions[accountId] = { capturedAt: now, cookies };
    const vault = await writeVault(key, store.vault, sessions);
    const updated = updateAccount({ ...store, vault }, accountId, {
      status: 'ok',
      sessionCapturedAt: now,
    });
    return updated.ok ? ok({ store: updated.value, value: undefined }) : updated;
  });
}

async function updateYoutube(deps: RouterDeps, accountId: string) {
  const current = await deps.youtube.readCurrent();
  if (!current.ok) return current;
  return patchStore(deps, (store) => {
    if (!findAccount(store, accountId)) return err('not_found');
    const youtube = copySession(current.value);
    return ok({
      ...store,
      accounts: store.accounts.map((a) =>
        a.id === accountId ? { ...a, youtube, status: 'ok' as const } : a,
      ),
    });
  });
}

async function remove(deps: RouterDeps, accountId: string) {
  const loaded = await readStore(deps);
  if (!loaded.ok) return loaded;
  const account = findAccount(loaded.value, accountId);
  if (!account) return err('not_found');
  if (deps.busy.has(account.platform)) return err('busy');
  if (account.platform === 'youtube') return patchStore(deps, (s) => removeAccount(s, accountId));
  // The saved session has to go too (design 2.4), and the vault can only be rewritten unlocked.
  const key = await getKey(deps.session);
  if (!key) return err('locked');
  return editStore(deps, async (store) => {
    const removed = removeAccount(store, accountId);
    if (!removed.ok) return removed;
    if (!store.vault) return ok({ store: removed.value, value: undefined });
    const sessions = await readVault(key, store.vault);
    delete sessions[accountId];
    const vault = await writeVault(key, store.vault, sessions);
    return ok({ store: { ...removed.value, vault }, value: undefined });
  });
}

async function switchTo(deps: RouterDeps, accountId: string, force: boolean) {
  const loaded = await readStore(deps);
  if (!loaded.ok) return loaded;
  const account = findAccount(loaded.value, accountId);
  if (!account) return err('not_found');
  if (isCookiePlatform(account.platform)) {
    return switchAccount(deps, account.platform, accountId, { force });
  }
  const target = account.youtube;
  if (!target) return err('not_found');
  return holdPlatform(deps.busy, 'youtube', () => switchYoutube(deps, accountId, target));
}

async function switchYoutube(deps: RouterDeps, accountId: string, target: YouTubeSession) {
  const switched = await deps.youtube.switchTo(target);
  await patchStore(deps, (store) => {
    // not_signed_in: Google account N is no longer the one saved (design 3.3), so press Update.
    const status = switched.ok ? 'ok' : switched.error === 'not_signed_in' ? 'expired' : undefined;
    if (status === undefined) return ok(store);
    const updated = updateAccount(
      store,
      accountId,
      switched.ok ? { status, lastUsedAt: deps.now() } : { status },
    );
    if (!updated.ok || !switched.ok) return updated;
    return setActive(updated.value, 'youtube', accountId);
  });
  return switched;
}
