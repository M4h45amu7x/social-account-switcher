import { expect, test } from 'bun:test';
import manifest from '../../package.json';
import { mountPopup } from '../../src/popup/app';
import { createTranslator } from '../../src/popup/i18n';
import { EXTRA_STATES, SAMPLE_STATES, sampleState } from '../../src/popup/samples';
import { renderPopup } from '../../src/popup/view';

for (const lang of ['en', 'th'] as const) {
  test(`version is accessible in every footer and Settings (${lang})`, () => {
    for (const name of [...SAMPLE_STATES, ...EXTRA_STATES]) {
      const root = document.createElement('main');
      renderPopup(root, sampleState(name, lang), createTranslator(lang), manifest.version);
      const badge = root.querySelector('footer [data-testid="footer-version"]');
      expect(badge?.textContent).toBe(`v${manifest.version}`);
      expect(badge?.getAttribute('aria-label')).toBe(
        createTranslator(lang).text('version_label', { version: manifest.version }),
      );
      if (name === 'settings' || name === 'settings-wipe')
        expect(root.querySelector('[data-testid="settings-version"]')?.textContent).toBe(
          `v${manifest.version}`,
        );
    }
  });
}

test('injected installed version survives settings, language and lock redraws', () => {
  const root = document.createElement('main');
  const app = mountPopup({
    root,
    cache: null,
    uiLanguage: 'en',
    state: sampleState('list', 'en'),
    version: '9.8.7.3',
  });
  for (const action of [
    { type: 'settings-open' },
    { type: 'pref-language', value: 'th' },
    { type: 'lock-now' },
  ] as const) {
    app.dispatch(action);
    expect(root.querySelector('[data-testid="footer-version"]')?.textContent).toBe('v9.8.7.3');
  }
});
