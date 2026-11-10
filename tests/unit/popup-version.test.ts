import { expect, test } from 'bun:test';
import manifest from '../../package.json';
import { mountPopup } from '../../src/popup/app';
import { createTranslator } from '../../src/popup/i18n';
import { EXTRA_STATES, SAMPLE_STATES, sampleState } from '../../src/popup/samples';
import { renderPopup } from '../../src/popup/view';

for (const lang of ['en', 'th'] as const) {
  test(`version appears once in every footer (${lang})`, () => {
    for (const name of [...SAMPLE_STATES, ...EXTRA_STATES]) {
      const root = document.createElement('main');
      renderPopup(root, sampleState(name, lang), createTranslator(lang), manifest.version);
      const badge = root.querySelector('footer [data-testid="footer-version"]');
      expect(badge?.textContent).toBe(`v${manifest.version}`);
      expect(badge?.getAttribute('aria-label')).toBe(
        createTranslator(lang).text('version_label', { version: manifest.version }),
      );
      expect(root.querySelectorAll('.extension-version').length).toBe(1);
      expect(root.querySelector('[data-testid="settings-version"]')).toBeNull();
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

test('approved Thai installed version label preserves the VERSION substitution', () => {
  expect(createTranslator('th').text('version_label', { version: '9.8.7.3' })).toBe(
    'เวอร์ชัน 9.8.7.3',
  );
});
