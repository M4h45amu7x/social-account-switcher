// The only background file allowed to use the global `chrome` (enforced by `bun run lint`).
// Keep every function a one-line pass-through that returns the Chrome promise, so nothing
// here can drop a promise. Logic lives elsewhere and receives these objects as parameters.
import type {
  CookiesApi,
  LifecycleApi,
  ScriptingApi,
  SessionStorageApi,
  StorageAreaApi,
  TabsApi,
} from '../lib/ports';

const area = (storage: chrome.storage.StorageArea): StorageAreaApi => ({
  get: (keys) => storage.get(keys),
  set: (items) => storage.set(items),
  remove: (keys) => storage.remove(keys),
});

export const localStorageApi: StorageAreaApi = area(chrome.storage.local);

export const sessionStorageApi: SessionStorageApi = {
  ...area(chrome.storage.session),
  setAccessLevel: (options) => chrome.storage.session.setAccessLevel(options),
};

export const lifecycleApi: LifecycleApi = {
  onInstalledOrStartup: (handler) => {
    chrome.runtime.onInstalled.addListener(handler);
    chrome.runtime.onStartup.addListener(handler);
  },
};

// @types/chrome describes the same objects with wider types (sameSite as an enum, optional fields
// as `| undefined`), so these casts only restate what the API returns.
export const cookiesApi: CookiesApi = {
  getAll: (details) => chrome.cookies.getAll(details) as ReturnType<CookiesApi['getAll']>,
  set: (details) => chrome.cookies.set(details) as ReturnType<CookiesApi['set']>,
  remove: (details) => chrome.cookies.remove(details),
};

export const tabsApi: TabsApi = {
  query: (query) => chrome.tabs.query(query),
  reload: (tabId) => chrome.tabs.reload(tabId),
  update: (tabId, props) => chrome.tabs.update(tabId, props),
  create: (props) => chrome.tabs.create(props),
};

export const scriptingApi: ScriptingApi = {
  executeScript: <T>(injection: Parameters<ScriptingApi['executeScript']>[0]) =>
    chrome.scripting.executeScript(injection) as Promise<{ result?: T }[]>,
};
