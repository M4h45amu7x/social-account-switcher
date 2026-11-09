// Pure render functions (state → DOM). B1 renders a placeholder; B5 ports mockup/popup.html here.

/** Looks up a UI string. In the extension this is chrome.i18n.getMessage; tests pass a stub. */
export type Translate = (key: MessageKey, substitutions?: string[]) => string;

export type MessageKey = 'popupTitle' | 'popupComingSoon' | 'popupFooter';

export interface PopupState {
  readonly version: string;
}

export function renderPopup(root: HTMLElement, state: PopupState, t: Translate): void {
  root.replaceChildren();
  const doc = root.ownerDocument;

  const title = doc.createElement('h1');
  title.textContent = t('popupTitle');

  const body = doc.createElement('p');
  body.textContent = t('popupComingSoon');

  const foot = doc.createElement('p');
  foot.className = 'foot';
  foot.textContent = t('popupFooter', [state.version]);

  root.append(title, body, foot);
}
