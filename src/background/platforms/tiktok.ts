// Experimental TikTok policy. The viewer schema below is synthetic, not a verified live-site API.
import type { ScriptingApi, TabsApi } from '../../lib/ports';
import { err, ok, type Result } from '../../lib/result';
import type { CookiePlatform, CookieProbeError } from './types';

/** Self-contained MAIN-world reader for local fixtures. Never reads feed authors or calls the site. */
export function readFixtureViewer(): unknown {
  try {
    const text = document.getElementById('__SAM_TIKTOK_VIEWER__')?.textContent;
    if (!text || text.length > 4096) return { state: 'unknown' };
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unknown' };
    const data = value as Record<string, unknown>;
    if (data.state === 'checkpoint') return { state: 'checkpoint' };
    if (data.state === 'logged_out') return { state: 'logged_out' };
    if (
      data.state === 'signed_in' &&
      typeof data.viewerId === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(data.viewerId)
    ) {
      return { state: 'signed_in', viewerId: data.viewerId };
    }
  } catch {
    /* Unknown page state is never an expiry claim. */
  }
  return { state: 'unknown' };
}

// Single gate for the experimental cookie boundary and unverified synthetic viewer schema.
// Enable only in tests until the owner confirms a real authenticated contract (design13).
export const TIKTOK_EXPERIMENT = {
  enabled: false,
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
      /^[A-Za-z0-9_-]{1,128}$/.test(data.viewerId)
    )
      return ok(data.viewerId);
    return err('tiktok_probe_unavailable');
  } catch {
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
  probe: async () => err('tiktok_disabled'),
};
