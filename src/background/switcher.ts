// Switches the browser from one Facebook or Instagram account to another by swapping session
// cookies (docs/design.md 3.0, steps 0 to 8, and 3.4).
import { clear, isExpired, restore, type StoredCookie, snapshot } from '../lib/cookies';
import type { Mutex } from '../lib/mutex';
import type {
  BrowserTab,
  CookiesApi,
  SessionStorageApi,
  StorageAreaApi,
  TabsApi,
} from '../lib/ports';
import { err, ok, type Result } from '../lib/result';
import { type Account, findAccount, type StoreV1, setActive, updateAccount } from '../lib/store';
import { readVault, sealCookies, writeVault } from '../lib/vault';
import { clearJournal, writeJournal } from './journal';
import { getKey } from './keyring';
import type { CookiePlatform, CookiePlatformId } from './platforms/types';
import { editStore, patchStore, readStore, type StoreError } from './store-access';

export type SwitchError =
  | 'locked'
  | 'busy'
  | 'expired'
  | 'checkpoint'
  | 'not_found'
  | 'unsaved_current'
  | StoreError;

export interface SwitchDeps {
  cookies: CookiesApi;
  tabs: TabsApi;
  local: StorageAreaApi;
  session: SessionStorageApi;
  platforms: Readonly<Record<CookiePlatformId, CookiePlatform>>;
  storeMutex: Mutex;
  /** Platforms with a switch in progress (step 0). Shared with the router and journal recovery. */
  busy: Set<CookiePlatformId>;
  now(): number;
  /** How long step 7 waits for the first tab to finish loading before it checks cookies anyway. */
  loadTimeoutMs: number;
}

/**
 * Steps 0 to 8 of design 3.0. Returns how many tabs were reloaded, or why the switch did not happen.
 * `force` switches even when the account in the browser now isn't saved (it will be logged out).
 */
export async function switchAccount(
  deps: SwitchDeps,
  platform: CookiePlatformId,
  accountId: string,
  opts: { force?: boolean } = {},
): Promise<Result<{ reloadedTabs: number }, SwitchError>> {
  // 0. The lock is taken before the first await, so a second press can't slip in.
  if (deps.busy.has(platform)) return err('busy');
  deps.busy.add(platform);
  try {
    return await runSwitch(deps, deps.platforms[platform], accountId, opts.force === true);
  } finally {
    deps.busy.delete(platform);
  }
}

async function runSwitch(
  deps: SwitchDeps,
  p: CookiePlatform,
  accountId: string,
  force: boolean,
): Promise<Result<{ reloadedTabs: number }, SwitchError>> {
  const key = await getKey(deps.session);
  if (!key) return err('locked');
  const loaded = await readStore(deps);
  if (!loaded.ok) return loaded;
  const target = findAccount(loaded.value, accountId);
  if (!target || target.platform !== p.id || !loaded.value.vault) return err('not_found');
  const saved = (await readVault(key, loaded.value.vault))[accountId]?.cookies ?? [];
  const now = deps.now();
  if (saved.length === 0 || saved.every((c) => isExpired(c, now))) {
    await markAccount(deps, accountId, { status: 'expired' });
    return err('expired');
  }

  // 1. What the browser holds now.
  const current = await snapshot(deps.cookies, p);
  const currentId = current.find((c) => c.name === p.idCookie && c.value !== '')?.value ?? null;
  const from = loaded.value.accounts.find(
    (a) => a.platform === p.id && currentId !== null && a.platformUserId === currentId,
  );
  if (currentId !== null && !from && !force) return err('unsaved_current');

  // 2. The journal is written only now that its backup exists.
  await writeJournal(deps.session, {
    platform: p.id,
    fromId: from?.id ?? null,
    toId: accountId,
    backup: await sealCookies(key, current),
    startedAt: now,
  });

  let finished = false;
  try {
    const result = await applySwitch(deps, p, key, target, saved, current, from);
    finished = true;
    return result;
  } catch (error) {
    await putBack(deps, p, current);
    finished = true;
    throw error;
  } finally {
    // 8. Only once the browser is in a known state; otherwise recovery needs the journal.
    if (finished) await clearJournal(deps.session, p.id);
  }
}

async function applySwitch(
  deps: SwitchDeps,
  p: CookiePlatform,
  key: CryptoKey,
  target: Account,
  saved: StoredCookie[],
  current: StoredCookie[],
  from: Account | undefined,
): Promise<Result<{ reloadedTabs: number }, SwitchError>> {
  // 3. Keep the latest session of the account we're leaving.
  if (from) await saveSession(deps, key, from.id, current);

  // 4 and 5.
  await clear(deps.cookies, p);
  const restored = await restore(deps.cookies, saved, deps.now());
  if (!restored.ok) {
    await putBack(deps, p, current);
    await markAccount(deps, target.id, { status: 'expired' });
    return err('expired');
  }

  // 6 and 7.
  const { reloaded, firstLoaded } = await reloadTabs(deps, p);
  const tab = await firstLoaded;
  if (tab?.url !== undefined && p.isCheckpointUrl(tab.url)) {
    // The switch happened; the user has to finish the platform's check in the tab (design 3.4).
    await markAccount(deps, target.id, { status: 'checkpoint', lastUsedAt: deps.now() }, true);
    return err('checkpoint');
  }
  const nowId = (await snapshot(deps.cookies, p)).find((c) => c.name === p.idCookie)?.value;
  if (nowId === undefined || nowId !== target.platformUserId) {
    await putBack(deps, p, current);
    await reloadTabs(deps, p);
    await markAccount(deps, target.id, { status: 'expired' });
    return err('expired');
  }
  await markAccount(deps, target.id, { status: 'ok', lastUsedAt: deps.now() }, true);
  return ok({ reloadedTabs: reloaded });
}

/** Puts the cookies from before the switch back. */
async function putBack(deps: SwitchDeps, p: CookiePlatform, cookies: StoredCookie[]) {
  await clear(deps.cookies, p);
  await restore(deps.cookies, cookies, deps.now());
}

async function saveSession(deps: SwitchDeps, key: CryptoKey, id: string, cookies: StoredCookie[]) {
  const capturedAt = deps.now();
  await editStore(deps, async (store) => {
    if (!store.vault || !findAccount(store, id)) return ok({ store, value: undefined });
    const sessions = await readVault(key, store.vault);
    sessions[id] = { capturedAt, cookies };
    const vault = await writeVault(key, store.vault, sessions);
    const next = updateAccount({ ...store, vault }, id, { sessionCapturedAt: capturedAt });
    return ok({ store: next.ok ? next.value : store, value: undefined });
  });
}

async function markAccount(
  deps: SwitchDeps,
  id: string,
  patch: Parameters<typeof updateAccount>[2],
  makeActive = false,
) {
  await patchStore(deps, (store: StoreV1) => {
    const updated = updateAccount(store, id, patch);
    if (!updated.ok || !makeActive) return updated;
    const account = findAccount(updated.value, id);
    return account ? setActive(updated.value, account.platform, id) : updated;
  });
}

/**
 * Reloads every tab of the platform. `firstLoaded` resolves with the first tab (the active one if
 * there is one) once it has finished loading, or null when there is no tab or it takes too long.
 */
async function reloadTabs(deps: SwitchDeps, p: CookiePlatform) {
  const tabs = (await deps.tabs.query({ url: p.tabPatterns })).filter(
    (t): t is BrowserTab & { id: number } => t.id !== undefined,
  );
  const watched = tabs.find((t) => t.active) ?? tabs[0];
  const firstLoaded = watched ? waitForLoad(deps, watched.id) : Promise.resolve(null);
  let reloaded = 0;
  for (const tab of tabs) {
    if (
      await deps.tabs.reload(tab.id).then(
        () => true,
        () => false,
      )
    )
      reloaded += 1;
  }
  return { reloaded, firstLoaded };
}

function waitForLoad(deps: SwitchDeps, tabId: number): Promise<BrowserTab | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      // Too slow: check the cookies anyway, with whatever URL the tab has now.
      deps.tabs.get(tabId).then(resolve, () => resolve(null));
    }, deps.loadTimeoutMs);
    const stop = deps.tabs.onUpdated((id, info, tab) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      stop();
      resolve(tab);
    });
  });
}
