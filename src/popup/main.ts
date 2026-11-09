import { mountPopup } from './app';
import { createBridge, tabPattern } from './bridge';
import { countTabs, i18nApi, openTab, sendRequest } from './runtime';

function localCache(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const root = document.getElementById('app');
if (root) {
  const onEffect = createBridge({
    send: sendRequest,
    openTab,
    countTabs: (platform) => countTabs([tabPattern(platform)]),
    later: (fn, ms) => {
      setTimeout(fn, ms);
    },
    now: () => Date.now(),
  });
  // Opening the popup asks the worker what it holds (state.get) and draws the answer.
  const app = mountPopup({
    root,
    cache: localCache(),
    uiLanguage: i18nApi.getUILanguage(),
    startPage: 'loading',
    onEffect,
  });
  onEffect({ type: 'load' }, app);
}
