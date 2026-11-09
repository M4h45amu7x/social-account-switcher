import { extensionVersion, i18nApi } from './runtime';
import { renderPopup } from './view';

document.documentElement.lang = i18nApi.getUILanguage();
document.title = i18nApi.getMessage('popupTitle');

const root = document.getElementById('app');
if (root) {
  renderPopup(root, { version: extensionVersion() }, (key, subs) => i18nApi.getMessage(key, subs));
}
