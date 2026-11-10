import type { BrowserTab, TabsApi, TabUpdatedListener } from '../lib/ports';
import type { CookiePlatform } from './platforms/types';

type LoadDeps = { tabs: TabsApi; loadTimeoutMs: number; requireComplete?: boolean };
/**
 * Reloads every tab of the platform. `firstLoaded` resolves with the first tab (the active one if
 * there is one) once it has finished loading, or null when there is no tab or it takes too long.
 * Verified cookie probes require every queried tab to complete before taking the final snapshot: a
 * later response can rotate the shared session again. Legacy callers still wait only for one tab.
 */
export async function reloadTabs(deps: LoadDeps, p: CookiePlatform) {
  const tabs = (await deps.tabs.query({ url: p.tabPatterns })).filter(
    (t): t is BrowserTab & { id: number } => t.id !== undefined,
  );
  const watched = tabs.find((t) => t.active) ?? tabs[0];
  const firstLoaded = deps.requireComplete
    ? Promise.all(tabs.map((tab) => waitForLoad(deps, tab.id))).then((loaded) =>
        loaded.every((tab) => tab !== null)
          ? (loaded.find((tab) => tab?.id === watched?.id) ?? null)
          : null,
      )
    : watched
      ? waitForLoad(deps, watched.id)
      : Promise.resolve(null);
  let reloaded = 0;
  for (const tab of tabs) {
    if (
      await deps.tabs.reload(tab.id).then(
        () => true,
        () => false,
      )
    )
      reloaded += 1;
  }
  return { reloaded, firstLoaded };
}

function waitForLoad(deps: LoadDeps, tabId: number): Promise<BrowserTab | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      // Too slow: check the cookies anyway, with whatever URL the tab has now.
      if (deps.requireComplete) resolve(null);
      else deps.tabs.get(tabId).then(resolve, () => resolve(null));
    }, deps.loadTimeoutMs);
    const listener: TabUpdatedListener = (id, info, tab) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      stop();
      resolve(tab);
    };
    const stop = () => deps.tabs.onUpdated.removeListener(listener);
    deps.tabs.onUpdated.addListener(listener);
  });
}
