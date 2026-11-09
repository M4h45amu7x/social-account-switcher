// What the cookie-swapping code needs to know about a platform (docs/design.md 8.2).
// facebook.ts and instagram.ts (card B3) provide the values.
export interface CookiePlatform {
  id: 'facebook' | 'instagram';
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
  loginUrl: string;
  /** True for /checkpoint/, /challenge/ and similar pages. */
  isCheckpointUrl(url: string): boolean;
}
