// The site of each platform, in one list. The manifest's host permissions, the tab patterns and the
// popup's "which site is this tab on" all follow it (tests/unit/sites.test.ts keeps them in step), so a
// new platform is one more entry here plus its adapter. Pure: no chrome, no DOM.
import type { Platform } from './store';

export interface Site {
  readonly platform: Platform;
  /** The registrable domain. The host permission covers it and every subdomain. */
  readonly domain: string;
}

export const SITES: readonly Site[] = [
  { platform: 'facebook', domain: 'facebook.com' },
  { platform: 'instagram', domain: 'instagram.com' },
  { platform: 'youtube', domain: 'youtube.com' },
];

/** The match pattern of a site, as in host_permissions and tabs.query({ url }). */
export const hostPattern = (site: Site): string => `*://*.${site.domain}/*`;

/**
 * The platform whose site `url` is on, or null. Matches the domain itself and its subdomains
 * (www., m., web.) over http or https, as the host permission does, and nothing that only looks
 * alike: `facebook.com.evil.test`, `notfacebook.com` and `youtube.com@evil.test` are not matches.
 */
export function platformOfUrl(
  url: string | undefined,
  sites: readonly Site[] = SITES,
): Platform | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // URL lower-cases the host and decodes IDNA; a trailing dot names the same host
  const host = parsed.hostname.replace(/\.$/, '');
  for (const site of sites) {
    const domain = site.domain.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return site.platform;
  }
  return null;
}
