import { clear, currentUserId, type StoredCookie, snapshot } from '../../lib/cookies';
import type { CookiesApi } from '../../lib/ports';
import { err, ok, type Result } from '../../lib/result';
import type { CookiePlatform, CookieProbeError } from './types';

export async function readIdentity(
  api: CookiesApi,
  p: CookiePlatform,
  tabId?: number,
): Promise<Result<string | null, CookieProbeError>> {
  if (p.enabled === false) return err('tiktok_disabled');
  return p.probe ? p.probe(tabId) : ok(await currentUserId(api, p));
}

/** Bracket the snapshot with viewer reads; a navigation must not label another account's cookies. */
export async function captureSession(
  api: CookiesApi,
  p: CookiePlatform,
  tabId?: number,
): Promise<Result<{ identity: string | null; cookies: StoredCookie[] }, CookieProbeError>> {
  const before = await readIdentity(api, p, tabId);
  if (!before.ok) return before;
  const cookies = await snapshot(api, p);
  if (p.probe) {
    const after = await readIdentity(api, p, tabId);
    if (!after.ok) return after;
    if (before.value !== after.value) return err('tiktok_probe_unavailable');
  }
  return ok({ identity: before.value, cookies });
}

/** A refused deletion must not combine two accounts' session members. */
export async function clearSession(api: CookiesApi, p: CookiePlatform): Promise<boolean> {
  await clear(api, p);
  return (await snapshot(api, p)).length === 0;
}
