// The only popup file allowed to use the global `chrome` (enforced by biome.json).
// Keep these as thin pass-throughs; the popup logic receives them as parameters.
import type { I18nApi } from '../lib/ports';

export const i18nApi: I18nApi = {
  getMessage: (key, substitutions) => chrome.i18n.getMessage(key, substitutions),
  getUILanguage: () => chrome.i18n.getUILanguage(),
};
