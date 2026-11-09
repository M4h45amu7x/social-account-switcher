// Service worker entry (docs/design.md 8.1). Wires the real Chrome adapters into the router, locks
// storage.session to trusted contexts, and rolls back any switch that a previous worker left half done.
import { createMutex } from '../lib/mutex';
import type { LifecycleApi, SessionStorageApi } from '../lib/ports';
import { err } from '../lib/result';
import {
  cookiesApi,
  lifecycleApi,
  localStorageApi,
  runtimeApi,
  sessionStorageApi,
  tabsApi,
} from './chrome-adapter';
import { COOKIE_PLATFORMS } from './platforms';
import type { CookiePlatformId } from './platforms/types';
import { createRouter, type RouterDeps, type YoutubeSwitcher } from './router';

/** Keep chrome.storage.session readable only by extension pages, never by content scripts (design §5). */
export async function hardenSessionStorage(session: SessionStorageApi): Promise<void> {
  await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export function start(lifecycle: LifecycleApi, session: SessionStorageApi): void {
  lifecycle.onInstalledOrStartup(() => {
    hardenSessionStorage(session).catch((error: unknown) => {
      console.error('Could not restrict storage.session access', error);
    });
  });
}

/** Stand-in until card B4 (t-532) lands youtube.ts; whichever card merges second wires the real one. */
export const youtubeNotWired: YoutubeSwitcher = {
  readCurrent: async () => err('unavailable'),
  switchTo: async () => err('unavailable'),
};

/** How long a switch waits for the first reloaded tab before it checks the cookies anyway. */
export const TAB_LOAD_TIMEOUT_MS = 15_000;

start(lifecycleApi, sessionStorageApi);

/** The real dependencies of the router: Chrome adapters, the platforms, a clock and IDs. */
export function workerDeps(): RouterDeps {
  return {
    extensionId: runtimeApi.id,
    cookies: cookiesApi,
    tabs: tabsApi,
    local: localStorageApi,
    session: sessionStorageApi,
    platforms: COOKIE_PLATFORMS,
    storeMutex: createMutex(),
    busy: new Set<CookiePlatformId>(),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    loadTimeoutMs: TAB_LOAD_TIMEOUT_MS,
    youtube: youtubeNotWired,
  };
}

// Created on every worker start, so a journal left by a stopped worker is recovered right away.
runtimeApi.onMessage(createRouter(workerDeps()).handle);
