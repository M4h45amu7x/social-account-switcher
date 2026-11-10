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
 * The id and URL of the tab the popup was opened over, from one current-window query. Chrome
 * exposes the URL only for sites in the host permissions. The popup keeps only the id.
 */
export const activeTab = async (): Promise<{ id?: number; url?: string } | undefined> => {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  return tab
    ? { ...(tab.id !== undefined ? { id: tab.id } : {}), ...(tab.url ? { url: tab.url } : {}) }
    : undefined;
};

/** How many open tabs match these URL patterns (host permissions cover the platform sites). */
export const countTabs = async (patterns: string[]): Promise<number> =>
  (await chrome.tabs.query({ url: patterns })).length;

/** Version of the installed extension, including unpacked builds. */
export const extensionVersion = (): string => chrome.runtime.getManifest().version;
