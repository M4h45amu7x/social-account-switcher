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

/** MIME and dimensions come from the bytes, not from the claimed data URL type. */
export function safeAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 32) return;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return;
  try {
    const bytes = atob(match[2] ?? '');
    if (bytes.length > MAX_AVATAR_BYTES || btoa(bytes) !== match[2]) return;
    const byte = (i: number) => bytes.charCodeAt(i);
    const be16 = (i: number) => byte(i) * 256 + byte(i + 1);
    const be32 = (i: number) => be16(i) * 65536 + be16(i + 2);
    const le24 = (i: number) => byte(i) + byte(i + 1) * 256 + byte(i + 2) * 65536;
    let width = 0;
    let height = 0;
    if (
      match[1] === 'png' &&
      bytes.startsWith('\x89PNG\r\n\x1a\n') &&
      bytes.slice(12, 16) === 'IHDR' &&
      be32(8) === 13 &&
      bytes.length >= 33
    ) {
      width = be32(16);
      height = be32(20);
    } else if (match[1] === 'jpeg' && bytes.startsWith('\xff\xd8') && bytes.endsWith('\xff\xd9')) {
      let i = 2;
      while (i + 8 < bytes.length && byte(i) === 255) {
        const marker = byte(i + 1);
        const length = be16(i + 2);
        if (length < 2 || i + 2 + length > bytes.length) return;
        if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
          height = be16(i + 5);
          width = be16(i + 7);
          break;
        }
        i += 2 + length;
      }
    } else if (
      match[1] === 'webp' &&
      bytes.startsWith('RIFF') &&
      bytes.slice(8, 12) === 'WEBP' &&
      bytes.length >= 30
    ) {
      const kind = bytes.slice(12, 16);
      if (kind === 'VP8X') {
        width = le24(24) + 1;
        height = le24(27) + 1;
      } else if (kind === 'VP8 ' && bytes.slice(23, 26) === '\x9d\x01\x2a') {
        width = (byte(26) + byte(27) * 256) & 0x3fff;
        height = (byte(28) + byte(29) * 256) & 0x3fff;
      } else if (kind === 'VP8L' && byte(20) === 0x2f) {
        width = 1 + (byte(21) | ((byte(22) & 0x3f) << 8));
        height = 1 + ((byte(22) >> 6) | (byte(23) << 2) | ((byte(24) & 0xf) << 10));
      }
    }
    return width > 0 && height > 0 && width <= MAX_AVATAR_SIDE && height <= MAX_AVATAR_SIDE
      ? value
      : undefined;
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
