import type { ScriptingApi, TabsApi, TabUpdatedListener } from '../lib/ports';
import { type AccountProfile, sanitizeProfile } from '../lib/profile';
import { platformOfUrl } from '../lib/sites';
import type { Platform } from '../lib/store';
import { canonicalAvatar } from './avatar';
import { isTikTok } from './platforms/tiktok';
import type { YouTubeSession } from './platforms/types';

declare const _sharedData: { config?: { viewer?: unknown } } | undefined;
declare const ytcfg: { get(key: string): unknown } | undefined;

/** Serialized by Chrome: no module closures, clicks, navigation or network/image-loading calls. */
export function readPageProfile(): unknown {
  try {
    const host = location.hostname.replace(/\.$/, '');
    const on = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    const record = (v: unknown): Record<string, unknown> =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const text = (v: unknown, max = 80): string | undefined =>
      typeof v === 'string' ? v.slice(0, max * 2) : undefined;
    const parse = (el: Element | null) => {
      const s = el?.textContent;
      if (!s || s.length > 262144) return undefined;
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return undefined;
      }
    };
    let identity: string | { authuser: number; pageid?: string } | undefined;
    let profile: { displayName?: string; handle?: string; email?: string; avatar?: string } = {};
    let avatarUrl: string | undefined;
    let root: Element | null = null;
    let identityStillMatches: (() => boolean) | undefined;
    const take = (
      v: Record<string, unknown>,
      keys: { name: string; handle: string; avatar: string },
    ) => {
      const name = text(v[keys.name]);
      const handle = text(v[keys.handle]);
      if (name) profile.displayName = name;
      if (handle) profile.handle = handle;
      avatarUrl = text(v[keys.avatar], 22000);
    };
    if (on('facebook.com')) {
      let viewer: Record<string, unknown> = {};
      let visited = 0;
      const find = (v: unknown, depth = 0): void => {
        if (++visited > 2000 || depth > 12 || viewer.USER_ID !== undefined) return;
        if (Array.isArray(v)) {
          if (v[0] === 'CurrentUserInitialData') {
            viewer = record(v[2]);
            return;
          }
          for (const item of v) find(item, depth + 1);
        } else for (const item of Object.values(record(v))) find(item, depth + 1);
      };
      for (const el of Array.from(
        document.querySelectorAll('script[type="application/json"][data-sjs]'),
      ).slice(0, 24)) {
        if (
          el.textContent &&
          el.textContent.length <= 262144 &&
          el.textContent.includes('CurrentUserInitialData')
        )
          find(parse(el));
        if (viewer.USER_ID !== undefined) break;
      }
      if (typeof viewer.USER_ID === 'string' && /^\d{1,128}$/.test(viewer.USER_ID)) {
        identity = viewer.USER_ID;
        take(viewer, { name: 'NAME', handle: 'USERNAME', avatar: 'PROFILE_PICTURE' });
      }
      for (const el of Array.from(
        document.querySelectorAll('nav a[href], header a[href], [role="navigation"] a[href]'),
      ).slice(0, 64)) {
        const u = new URL(el.getAttribute('href') ?? '', location.href);
        const id = u.searchParams.get('id');
        if (
          u.origin === location.origin &&
          u.pathname === '/profile.php' &&
          id &&
          /^\d{1,128}$/.test(id) &&
          (!identity || identity === id)
        ) {
          identity = id;
          root = el;
          break;
        }
      }
    } else if (on('instagram.com')) {
      let viewer = typeof _sharedData === 'undefined' ? {} : record(_sharedData?.config?.viewer);
      const globalViewer = !!viewer.id;
      if (!viewer.id)
        for (const el of Array.from(
          document.querySelectorAll('script[type="application/json"]'),
        ).slice(0, 24)) {
          viewer = record(record(record(parse(el)).config).viewer);
          if (viewer.id) break;
        }
      if (typeof viewer.id === 'string' && /^\d{1,128}$/.test(viewer.id)) {
        identity = viewer.id;
        identityStillMatches = () =>
          viewer.id === identity &&
          (!globalViewer ||
            (typeof _sharedData !== 'undefined' &&
              record(_sharedData?.config?.viewer).id === identity));
        take(viewer, { name: 'full_name', handle: 'username', avatar: 'profile_pic_url' });
      }
      for (const el of Array.from(
        document.querySelectorAll('nav a[data-user-id], header a[data-user-id]'),
      ).slice(0, 32)) {
        const id = el.getAttribute('data-user-id');
        if (id && /^\d{1,128}$/.test(id) && (!identity || identity === id)) {
          const u = new URL(el.getAttribute('href') ?? '', location.href);
          if (u.origin !== location.origin) continue;
          identity = id;
          root = el;
          if (!profile.handle && /^\/[A-Za-z0-9_.]+\/$/.test(u.pathname))
            profile.handle = u.pathname.slice(1, -1);
          break;
        }
      }
    } else if (on('youtube.com')) {
      if (typeof ytcfg === 'undefined' || !ytcfg) return null;
      const index = ytcfg.get('SESSION_INDEX');
      const authuser =
        typeof index === 'number'
          ? index
          : typeof index === 'string' && /^\d+$/.test(index)
            ? Number(index)
            : NaN;
      const pageid = ytcfg.get('DELEGATED_SESSION_ID');
      if (
        !Number.isSafeInteger(authuser) ||
        authuser < 0 ||
        (pageid && (typeof pageid !== 'string' || !/^\d+$/.test(pageid)))
      )
        return null;
      identity = typeof pageid === 'string' && pageid ? { authuser, pageid } : { authuser };
      identityStillMatches = () => {
        const currentIndex = ytcfg?.get('SESSION_INDEX');
        const currentPage = ytcfg?.get('DELEGATED_SESSION_ID');
        return (
          currentIndex === index &&
          currentPage === pageid &&
          (!root ||
            (root.getAttribute('data-session-index') === String(authuser) &&
              (root.getAttribute('data-delegated-session-id') || undefined) ===
                (pageid || undefined)))
        );
      };
      take(
        {
          name: ytcfg.get('ACCOUNT_NAME'),
          handle: ytcfg.get('CHANNEL_HANDLE'),
          avatar: ytcfg.get('AVATAR_URL'),
        },
        { name: 'name', handle: 'handle', avatar: 'avatar' },
      );
      const email = text(ytcfg.get('EMAIL'), 254);
      if (email) profile.email = email;
      // A stale rendered menu is not identified by the current global config. Only an
      // independently associated header may contribute; these attributes are optional candidates.
      root =
        Array.from(document.querySelectorAll('ytd-active-account-header-renderer'))
          .slice(0, 16)
          .find(
            (el) =>
              el.getAttribute('data-session-index') === String(authuser) &&
              (el.getAttribute('data-delegated-session-id') || undefined) === (pageid || undefined),
          ) ?? null;
      if (root) {
        const name = text(root.querySelector('#account-name')?.textContent);
        const handle = text(root.querySelector('#channel-handle')?.textContent);
        const mail = text(root.querySelector('#email')?.textContent, 254);
        if (!profile.displayName && name) profile.displayName = name;
        if (!profile.handle && handle) profile.handle = handle;
        if (!profile.email && mail) profile.email = mail;
      }
    } else if (on('tiktok.com')) {
      const viewer = record(parse(document.getElementById('__SAM_TIKTOK_VIEWER__')));
      if (
        viewer.state !== 'signed_in' ||
        typeof viewer.viewerId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(viewer.viewerId)
      )
        return null;
      identity = viewer.viewerId;
      take(viewer, { name: 'displayName', handle: 'username', avatar: 'avatar' });
      root =
        Array.from(document.querySelectorAll('[data-e2e="profile-icon"][data-user-id]'))
          .slice(0, 32)
          .find((el) => el.getAttribute('data-user-id') === identity) ?? null;
    } else return null;
    if (!identity) return null;
    if (!profile.displayName && root && !on('youtube.com')) {
      const name = text(root.getAttribute('title') || root.textContent);
      if (name) profile.displayName = name;
    }
    // The canvas is detached; drawing pixels of an already loaded image starts no request.
    // A cross-origin image without CORS taints it. That is an expected initials-only fallback.
    let img = root?.querySelector<HTMLImageElement>('img');
    if (avatarUrl)
      img = Array.from(document.images)
        .slice(0, 128)
        .find((el) => el.currentSrc === avatarUrl || el.src === avatarUrl);
    if (avatarUrl?.startsWith('data:image/') && avatarUrl.length <= 43730)
      profile.avatar = avatarUrl;
    else if (img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      try {
        const ratio = Math.min(1, 64 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/png');
          if (data.length <= 43730) profile.avatar = data;
        }
      } catch {
        /* unreadable pixels: keep initials */
      }
    }
    // No remote URLs or arbitrary page objects cross the scripting boundary.
    if (identityStillMatches && !identityStillMatches()) return null;
    profile = { ...profile };
    return { identity, profile };
  } catch {
    return null;
  }
}

export async function readProfile(
  deps: {
    tabs: TabsApi;
    scripting: ScriptingApi;
    currentIdentity(): Promise<string | YouTubeSession | null | undefined>;
    timeoutMs?: number;
  },
  platform: Platform,
  identity: string | YouTubeSession,
  tabId?: number,
): Promise<AccountProfile | undefined> {
  if (tabId === undefined) return;
  let finished = false;
  let navigated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const updated: TabUpdatedListener = (id, info) => {
    if (id === tabId && (info.status === 'loading' || info.url !== undefined)) navigated = true;
  };
  const matches = (other: unknown): boolean => {
    if (typeof identity === 'string') return other === identity;
    if (!other || typeof other !== 'object') return false;
    const value = other as Partial<YouTubeSession>;
    return value.authuser === identity.authuser && value.pageid === identity.pageid;
  };
  try {
    deps.tabs.onUpdated.addListener(updated);
    // Optional metadata must never retain the account operation's lock indefinitely.
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        finished = true;
        resolve(undefined);
      }, deps.timeoutMs ?? 1000);
    });
    const read = async () => {
      const before = await deps.tabs.get(tabId);
      if (finished || navigated || before.pendingUrl || before.status === 'loading') return;
      const beforeUrl = before.url;
      if (platform === 'tiktok' ? !isTikTok(beforeUrl) : platformOfUrl(beforeUrl) !== platform)
        return;
      const result = await deps.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readPageProfile,
      });
      if (finished || navigated) return;
      const value = result.find((frame) => frame.frameId === 0)?.result;
      if (!value || typeof value !== 'object') return;
      const v = value as { identity?: unknown; profile?: unknown };
      if (!matches(v.identity)) return;
      const profile = sanitizeProfile(v.profile) ?? {};
      // Never retain the original avatar, including one that passes the storage shape check.
      delete profile.avatar;
      const source =
        v.profile && typeof v.profile === 'object'
          ? (v.profile as Record<string, unknown>).avatar
          : undefined;
      const avatar = await canonicalAvatar(source);
      if (avatar) profile.avatar = avatar;
      if (finished || navigated) return;
      const current = await deps.currentIdentity();
      if (finished || navigated || !matches(current)) return;
      const after = await deps.tabs.get(tabId);
      if (
        finished ||
        navigated ||
        after.url !== beforeUrl ||
        after.pendingUrl ||
        after.status === 'loading'
      )
        return;
      return Object.keys(profile).length ? profile : undefined;
    };
    return await Promise.race([deadline, read()]);
  } catch {
    return undefined;
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    deps.tabs.onUpdated.removeListener(updated);
  }
}
