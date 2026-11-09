// The switch journal (docs/design.md 3.0 and 5). While a switch runs, storage.session holds the
// encrypted cookies that were in the browser before it started. If the service worker dies halfway,
// the next start finds the journal and puts those cookies back.
//
// There is one journal per platform (key `journal.facebook`, `journal.instagram`) rather than the
// single `journal` of design 5, because Facebook and Instagram may switch at the same time.
import { clear, restore, type StoredCookie } from '../lib/cookies';
import type { CookiesApi, SessionStorageApi, TabsApi } from '../lib/ports';
import { err, ok, type Result } from '../lib/result';
import { openCookies } from '../lib/vault';
import { getKey } from './keyring';
import type { CookiePlatform, CookiePlatformId } from './platforms/types';

export interface Journal {
  platform: CookiePlatformId;
  fromId: string | null;
  toId: string;
  /** sealCookies() of the snapshot taken before the switch. Never plain cookies. */
  backup: string;
  startedAt: number;
}

export const journalKey = (platform: CookiePlatformId): string => `journal.${platform}`;

export async function writeJournal(session: SessionStorageApi, journal: Journal): Promise<void> {
  await session.set({ [journalKey(journal.platform)]: journal });
}

export async function clearJournal(
  session: SessionStorageApi,
  platform: CookiePlatformId,
): Promise<void> {
  await session.remove(journalKey(platform));
}

function isJournal(v: unknown, platform: CookiePlatformId): v is Journal {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Record<string, unknown>;
  return (
    j.platform === platform &&
    (j.fromId === null || typeof j.fromId === 'string') &&
    typeof j.toId === 'string' &&
    typeof j.backup === 'string' &&
    typeof j.startedAt === 'number'
  );
}

/** The platform's journal, or null when there is none. A malformed entry counts as none. */
export async function readJournal(
  session: SessionStorageApi,
  platform: CookiePlatformId,
): Promise<Journal | null> {
  const value = (await session.get(journalKey(platform)))[journalKey(platform)];
  return isJournal(value, platform) ? value : null;
}

export interface RecoverDeps {
  session: SessionStorageApi;
  cookies: CookiesApi;
  tabs: TabsApi;
  platforms: Readonly<Record<CookiePlatformId, CookiePlatform>>;
  /**
   * Platforms with a switch running in this worker; their journal belongs to that switch.
   * Recovery takes the same lock while it puts a backup back.
   */
  busy: Set<CookiePlatformId>;
  now(): number;
}

export interface RecoverReport {
  rolledBack: CookiePlatformId[];
  /** Journals left in place because the vault is locked; they are retried after the next unlock. */
  waiting: CookiePlatformId[];
  /** Journals whose backup could not be decrypted; they were dropped. */
  dropped: CookiePlatformId[];
}

/**
 * Puts back the cookies of every switch that didn't finish, then deletes its journal and reloads the
 * platform's tabs. Runs when the worker starts and after an unlock.
 */
export async function recoverJournal(deps: RecoverDeps): Promise<RecoverReport> {
  const report: RecoverReport = { rolledBack: [], waiting: [], dropped: [] };
  for (const platform of Object.values(deps.platforms)) {
    if (deps.busy.has(platform.id)) continue;
    // Held like a switch, so a switch or an add can't start while the backup goes back.
    deps.busy.add(platform.id);
    try {
      await recoverPlatform(deps, platform, report);
    } finally {
      deps.busy.delete(platform.id);
    }
  }
  return report;
}

async function recoverPlatform(deps: RecoverDeps, platform: CookiePlatform, report: RecoverReport) {
  const journal = await readJournal(deps.session, platform.id);
  if (!journal) return;
  const backup = await openBackup(deps.session, journal);
  if (!backup.ok) {
    if (backup.error === 'locked') {
      report.waiting.push(platform.id);
      return;
    }
    await clearJournal(deps.session, platform.id);
    report.dropped.push(platform.id);
    return;
  }
  await clear(deps.cookies, platform);
  await restore(deps.cookies, backup.value, deps.now());
  await clearJournal(deps.session, platform.id);
  await reloadAll(deps.tabs, platform);
  report.rolledBack.push(platform.id);
}

async function openBackup(
  session: SessionStorageApi,
  journal: Journal,
): Promise<Result<StoredCookie[], 'locked' | 'unreadable'>> {
  const key = await getKey(session);
  if (!key) return err('locked');
  try {
    return ok(await openCookies(key, journal.backup));
  } catch {
    return err('unreadable');
  }
}

async function reloadAll(tabs: TabsApi, platform: CookiePlatform): Promise<void> {
  for (const tab of await tabs.query({ url: platform.tabPatterns })) {
    if (tab.id !== undefined) await tabs.reload(tab.id).catch(() => undefined);
  }
}
