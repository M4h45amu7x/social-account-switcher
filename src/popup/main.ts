import { mountPopup } from './app';
import { createBridge, tabPattern } from './bridge';
import { activeTabUrl, countTabs, i18nApi, openTab, sendRequest } from './runtime';
import { pickStartPlatform, readPlatformCache, siteOfActiveTab } from './start';

/** Longest wait for the active tab's URL before the popup draws without it. */
const ACTIVE_TAB_WAIT_MS = 150;

function localCache(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const later = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms);
};

async function start(root: HTMLElement): Promise<void> {
  const cache = localCache();
  const here = await siteOfActiveTab(activeTabUrl, ACTIVE_TAB_WAIT_MS, later);
  const onEffect = createBridge({
    send: sendRequest,
    openTab,
    countTabs: (platform) => countTabs([tabPattern(platform)]),
    later,
    now: () => Date.now(),
  });
  // Opening the popup asks the worker what it holds (state.get) and draws the answer.
  const app = mountPopup({
    root,
    cache,
    uiLanguage: i18nApi.getUILanguage(),
    startPage: 'loading',
    platform: pickStartPlatform(here, readPlatformCache(cache)),
    here,
    onEffect,
  });
  onEffect({ type: 'load' }, app);
}

const root = document.getElementById('app');
if (root) void start(root);
