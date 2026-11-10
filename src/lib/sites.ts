import type { PopupPlatform as Platform } from './store';

export interface Site {
  readonly platform: Platform;
  /** The registrable domain. The host permission covers it and every subdomain. */
  readonly domain: string;
  readonly httpsOnly?: boolean;
}

export const SITES: readonly Site[] = [
  { platform: 'facebook', domain: 'facebook.com' },
  { platform: 'instagram', domain: 'instagram.com' },
  { platform: 'youtube', domain: 'youtube.com' },
  { platform: 'tiktok', domain: 'tiktok.com', httpsOnly: true },
];

/** The match pattern of a site, as in host_permissions and tabs.query({ url }). */
export const hostPattern = (site: Site): string =>
  `${site.httpsOnly ? 'https' : '*'}://*.${site.domain}/*`;

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
    if (site.httpsOnly && parsed.protocol !== 'https:') continue;
    const domain = site.domain.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return site.platform;
  }
  return null;
}
