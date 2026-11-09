import { mountPopup } from './app';
import { i18nApi } from './runtime';

function localCache(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const root = document.getElementById('app');
if (root) {
  // B5a draws and navigates only. B5b passes `onEffect` to send each effect to the service worker and
  // feeds the answers back with app.dispatch({ type: 'platform-loaded' | 'switch-done' | ... }).
  mountPopup({ root, cache: localCache(), uiLanguage: i18nApi.getUILanguage() });
}
