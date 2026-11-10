// TikTok reader uses a strictly validated candidate schema; live owner confirmation is pending.
import type { ScriptingApi, TabsApi } from '../../lib/ports';
import { err, ok, type Result } from '../../lib/result';
import type { CookiePlatform, CookieProbeError } from './types';

/** Self-contained MAIN-world reader. Candidate selectors/schema remain owner-unconfirmed.
 * Parse at most 1,048,576 characters of existing hydration text; return only the stable UID/state.
 * No site functions, requests, author/profile fallbacks or retained hydration objects.
 */
export function readFixtureViewer(): unknown {
  try {
    // Explicit challenge containers take precedence even when hydration is absent or stale.
    if (document.querySelector('#captcha_container, #verifyEle, [data-e2e="captcha"]'))
      return { state: 'checkpoint' };
    const text = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent;
    if (!text || text.length > 1024 * 1024) return { state: 'unknown' };
    const object = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v);
    const value: unknown = JSON.parse(text);
    if (!object(value) || !object(value.__DEFAULT_SCOPE__)) return { state: 'unknown' };
    const context = value.__DEFAULT_SCOPE__['webapp.app-context'];
    if (!object(context)) return { state: 'unknown' };
    const user = context.user;
    if (context.isLogin === false) {
      // Null/empty user plus an explicit false discriminator is the only logout contract.
      // Contradictory identity data is unknown, never evidence of expiry.
      return user === null || (object(user) && Object.keys(user).length === 0)
        ? { state: 'logged_out' }
        : { state: 'unknown' };
    }
    if (context.isLogin !== undefined && context.isLogin !== true) return { state: 'unknown' };
    if (
      object(user) &&
      typeof user.uid === 'string' &&
      /^[1-9][0-9]{0,31}$/.test(user.uid) &&
      typeof user.uniqueId === 'string' &&
      /^[A-Za-z0-9_.]{1,128}$/.test(user.uniqueId)
    )
      return { state: 'signed_in', viewerId: user.uid };
  } catch {
    /* Unknown page state is never an expiry claim. */
  }
  return { state: 'unknown' };
}

// Enabled by the T3 implementation brief; live compatibility and release remain owner gates.
export const TIKTOK_EXPERIMENT = {
  enabled: true,
  // Owner-observed names (2026-11-10) establish presence, not function or sufficiency.
  // Preserve browser/security state, including both host-only and domain copies.
  preservedCookieNames: [
    'ttwid',
    'msToken',
    's_v_web_id',
    'tt_chain_token',
    'odin_tt',
    'tt_ticket_guard_has_set_public_key',
    'security_verification_ticket',
    'x-web-secsdk-uid',
    'gd_random',
  ] as readonly string[],
  viewerReader: readFixtureViewer,
};
export type TikTokConfig = typeof TIKTOK_EXPERIMENT;
export interface TikTokDeps {
  tabs: TabsApi;
  scripting: ScriptingApi;
  hasPermission?: () => Promise<boolean>;
}

export const isTikTok = (url: string | undefined): boolean => {
  try {
    const u = new URL(url ?? '');
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com'))
    );
  } catch {
    return false;
  }
};

async function readViewer(
  deps: TikTokDeps,
  config: TikTokConfig,
  tabId?: number,
): Promise<Result<string | null, CookieProbeError>> {
  if (!config.enabled) return err('tiktok_disabled');
  try {
    if (deps.hasPermission && !(await deps.hasPermission())) return err('tiktok_permission');
    // Explicit popup/load context never falls back to a different window.
    const tab =
      tabId === undefined
        ? (
            await deps.tabs.query({
              url: ['https://*.tiktok.com/*'],
              active: true,
              currentWindow: true,
            })
          ).find((t) => t.active && isTikTok(t.url))
        : await deps.tabs.get(tabId).catch(() => undefined);
    if (tab?.id === undefined || !isTikTok(tab.url)) return err('no_tiktok_tab');
    const frames = await deps.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: config.viewerReader,
    });
    // A navigation while scripting runs must not lend an unrelated page a trusted identity.
    if (!isTikTok((await deps.tabs.get(tab.id)).url)) return err('tiktok_probe_unavailable');
    const main = frames.filter((f) => f.frameId === 0);
    if (main.length !== 1) return err('tiktok_probe_unavailable');
    const value = main[0]?.result;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return err('tiktok_probe_unavailable');
    const data = value as Record<string, unknown>;
    if (data.state === 'checkpoint') return err('checkpoint');
    if (data.state === 'logged_out') return ok(null);
    if (
      data.state === 'signed_in' &&
      typeof data.viewerId === 'string' &&
      /^[1-9][0-9]{0,31}$/.test(data.viewerId)
    )
      return ok(data.viewerId);
    return err('tiktok_probe_unavailable');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Chromium's explicit scripting host-denial messages. Never expose raw page/API errors.
    if (
      /Cannot access contents of (?:url|the page).*Extension manifest must request permission to access (?:this|the respective) host/i.test(
        message,
      )
    )
      return err('tiktok_permission');
    return err('api_error');
  }
}

const policy = (config: TikTokConfig): CookiePlatform => ({
  id: 'tiktok',
  label: 'TikTok',
  cookieDomain: 'tiktok.com',
  tabPatterns: ['https://*.tiktok.com/*'],
  idCookie: '',
  deviceCookies: new Set(config.preservedCookieNames),
  httpsOnly: true,
  enabled: config.enabled,
  loginUrl: 'https://www.tiktok.com/login',
  isCheckpointUrl: () => false,
});
export function createTikTokPlatform(
  deps: TikTokDeps,
  config: TikTokConfig = TIKTOK_EXPERIMENT,
): CookiePlatform {
  return { ...policy(config), probe: (tabId) => readViewer(deps, config, tabId) };
}
// Registration has no browser access; production dependencies are injected by the worker.
export const tiktok: CookiePlatform = {
  ...policy(TIKTOK_EXPERIMENT),
  probe: async () => err('tiktok_probe_unavailable'),
};
