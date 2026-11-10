/** Small, non-secret account metadata. It is stored unencrypted beside the account label. */
export interface AccountProfile {
  displayName?: string;
  handle?: string;
  email?: string;
  avatar?: string;
}

export const MAX_AVATAR_BYTES = 32_768;
const MAX_AVATAR_SIDE = 64;

/** Page strings are text, never markup. Limits count Unicode code points. */
export function profileText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = [
    ...value
      .slice(0, 4096)
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('');
  return text || undefined;
}

/** Stored avatars are complete canonical PNGs, never original page bytes.
 * Browser decoding/re-encoding happens at capture; this check also protects legacy storage/rendering.
 */
export function safeAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 32) return;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return;
  try {
    const bytes = atob(match[1] ?? '');
    if (bytes.length > MAX_AVATAR_BYTES || btoa(bytes) !== match[1]) return;
    if (!bytes.startsWith('\x89PNG\r\n\x1a\n')) return;
    const byte = (i: number) => bytes.charCodeAt(i);
    const be32 = (i: number) =>
      byte(i) * 16777216 + byte(i + 1) * 65536 + byte(i + 2) * 256 + byte(i + 3);
    let header = false;
    let pixels = false;
    for (let i = 8; i + 12 <= bytes.length; ) {
      const length = be32(i);
      const end = i + 8 + length;
      if (end + 4 > bytes.length) return;
      const kind = bytes.slice(i + 4, i + 8);
      let crc = 0xffffffff;
      for (let j = i + 4; j < end; j++) {
        crc ^= byte(j);
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      if ((crc ^ 0xffffffff) >>> 0 !== be32(end)) return;
      if (kind === 'IHDR' && !header && i === 8 && length === 13) {
        const width = be32(i + 8);
        const height = be32(i + 12);
        if (width < 1 || height < 1 || width > MAX_AVATAR_SIDE || height > MAX_AVATAR_SIDE) return;
        header = true;
      } else if (kind === 'IDAT' && header && length > 0) pixels = true;
      else if (kind === 'IEND' && header && pixels && length === 0)
        return end + 4 === bytes.length ? value : undefined;
      // Browser encoders may include a standard rendering intent; no arbitrary ancillary payloads.
      else if (!(kind === 'sRGB' && header && !pixels && length === 1 && byte(i + 8) <= 3)) return;
      i = end + 4;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeProfile(value: unknown): AccountProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const profile: AccountProfile = {};
  const displayName = profileText(v.displayName, 80);
  const handle = profileText(v.handle, 80);
  const email = profileText(v.email, 254);
  const avatar = safeAvatar(v.avatar);
  if (displayName) profile.displayName = displayName;
  if (handle) profile.handle = handle;
  if (email) profile.email = email;
  if (avatar) profile.avatar = avatar;
  return Object.keys(profile).length ? profile : undefined;
}
