// The only background file allowed to use the global `chrome` (enforced by biome.json).
// Keep every function a one-line pass-through that returns the Chrome promise, so nothing
// here can drop a promise. Logic lives elsewhere and receives these objects as parameters.
import type { LifecycleApi, SessionStorageApi } from '../lib/ports';

export const sessionStorageApi: SessionStorageApi = {
  setAccessLevel: (options) => chrome.storage.session.setAccessLevel(options),
};

export const lifecycleApi: LifecycleApi = {
  onInstalledOrStartup: (handler) => {
    chrome.runtime.onInstalled.addListener(handler);
    chrome.runtime.onStartup.addListener(handler);
  },
};
