// The only popup file allowed to use the global `chrome` (enforced by biome.json).
// Keep these as thin pass-throughs; the popup logic receives them as parameters.
import type { I18nApi } from '../lib/ports';

export const i18nApi: I18nApi = {
  getMessage: (key, substitutions) => chrome.i18n.getMessage(key, substitutions),
  getUILanguage: () => chrome.i18n.getUILanguage(),
};

// The popup's only line to the service worker: one request in, one answer out. The answer is checked
// by src/popup/bridge.ts; nothing here looks inside it.
export const sendRequest = (message: unknown): Promise<unknown> =>
  chrome.runtime.sendMessage(message);

/** Opens a page in a new tab. */
export const openTab = async (url: string): Promise<void> => {
  await chrome.tabs.create({ url });
};

/**
 * The URL of the tab the popup was opened over. Chrome fills it in only for sites in the extension's
 * host permissions; for any other page it is undefined. Nothing here keeps it.
 */
export const activeTabUrl = async (): Promise<string | undefined> =>
  (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url;

/** How many open tabs match these URL patterns (host permissions cover the three sites). */
export const countTabs = async (patterns: string[]): Promise<number> =>
  (await chrome.tabs.query({ url: patterns })).length;
