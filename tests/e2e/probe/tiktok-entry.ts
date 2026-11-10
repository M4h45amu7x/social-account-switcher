// Test-only service worker. Production entry/flag are never rewritten.

import {
  cookiesApi,
  localStorageApi,
  permissionsApi,
  runtimeApi,
  scriptingApi,
  sessionStorageApi,
  tabsApi,
} from '../../../src/background/chrome-adapter';
import { getKey } from '../../../src/background/keyring';
import { COOKIE_PLATFORMS } from '../../../src/background/platforms';
import { createTikTokPlatform, TIKTOK_EXPERIMENT } from '../../../src/background/platforms/tiktok';
import { createYoutubeSwitcher } from '../../../src/background/platforms/youtube';
import { createRouter } from '../../../src/background/router';
import { createMutex } from '../../../src/lib/mutex';
import { loadStore } from '../../../src/lib/store';
import { readVault } from '../../../src/lib/vault';

const writes: import('../../../src/lib/ports').BrowserCookie[] = [];
let hold = false;
let held = false;
let release: (() => void) | undefined;
const cookies = {
  ...cookiesApi,
  set: async (details: Parameters<typeof cookiesApi.set>[0]) => {
    const cookie = await cookiesApi.set(details);
    if (cookie) writes.push(cookie);
    return cookie;
  },
  remove: async (details: Parameters<typeof cookiesApi.remove>[0]) => {
    if (hold) {
      hold = false;
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      held = false;
    }
    return cookiesApi.remove(details);
  },
};
const deps = {
  extensionId: runtimeApi.id,
  cookies,
  tabs: tabsApi,
  scripting: scriptingApi,
  local: localStorageApi,
  session: sessionStorageApi,
  platforms: {
    ...COOKIE_PLATFORMS,
    tiktok: createTikTokPlatform(
      {
        tabs: tabsApi,
        scripting: scriptingApi,
        hasPermission: () => permissionsApi.contains({ origins: ['https://*.tiktok.com/*'] }),
      },
      { ...TIKTOK_EXPERIMENT, enabled: true },
    ),
  },
  storeMutex: createMutex(),
  busy: new Set<import('../../../src/lib/store').Platform>(),
  now: Date.now,
  newId: () => crypto.randomUUID(),
  loadTimeoutMs: 4000,
  youtube: createYoutubeSwitcher({ tabs: tabsApi, scripting: scriptingApi, loadTimeoutMs: 4000 }),
};
const router = createRouter(deps);
runtimeApi.onMessage(router.handle);
Object.assign(globalThis, {
  __tiktokTest: {
    writes,
    clearWrites() {
      writes.length = 0;
    },
    hold() {
      hold = true;
    },
    get held() {
      return held;
    },
    release() {
      release?.();
    },
    async saved() {
      const store = await loadStore(localStorageApi);
      const key = await getKey(sessionStorageApi);
      if (!store.ok || !store.value.vault || !key) return {};
      return readVault(key, store.value.vault);
    },
    ready: router.ready,
  },
});
