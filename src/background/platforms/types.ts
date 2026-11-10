import type { Result } from '../../lib/result';

// What the cookie-swapping code needs to know about a platform (docs/design.md 8.2).
// facebook.ts and instagram.ts (card B3) provide the values.
export interface CookiePlatform {
  id: 'facebook' | 'instagram' | 'tiktok';
  /** Shown in the UI, e.g. 'Facebook'. */
  label: string;
  /** Registrable domain without a leading dot, e.g. 'facebook.com'. */
  cookieDomain: string;
  /** Match patterns for the platform's tabs, e.g. ['*://*.facebook.com/*']. */
  tabPatterns: string[];
  /** The cookie that holds the platform's user ID: 'c_user' or 'ds_user_id'. */
  idCookie: string;
  /** Cookies that identify the browser rather than the account. They are never swapped (design 3.0). */
  deviceCookies: ReadonlySet<string>;
  /** Use HTTPS for cookie API URLs even when a captured cookie has no Secure attribute. */
  httpsOnly?: boolean;
  enabled?: boolean;
  probe?: (tabId?: number) => Promise<Result<string | null, CookieProbeError>>;
  loginUrl: string;
  /** True for /checkpoint/, /challenge/ and similar pages. */
  isCheckpointUrl(url: string): boolean;
}

export type CookiePlatformId = CookiePlatform['id'];

/** Non-secret multi-login coordinates; never cookies, email or profile data. */
export interface YouTubeSession {
  readonly authuser: number;
  readonly pageid?: string;
}

export type YouTubeError =
  | 'no_youtube_tab'
  | 'not_signed_in'
  | 'invalid_session'
  | 'invalid_tab'
  | 'api_error';

/** What the router needs from the YouTube code (youtube.ts provides it). */
export interface YoutubeSwitcher {
  /** The Google session in exactly this tab; a missing id must never select another window. */
  readCurrent(tabId?: number): Promise<Result<YouTubeSession, YouTubeError>>;
  switchTo(target: YouTubeSession): Promise<Result<{ reloadedTabs: number }, YouTubeError>>;
}

export type CookieProbeError =
  | 'tiktok_disabled'
  | 'no_tiktok_tab'
  | 'tiktok_permission'
  | 'tiktok_probe_unavailable'
  | 'checkpoint'
  | 'api_error';
