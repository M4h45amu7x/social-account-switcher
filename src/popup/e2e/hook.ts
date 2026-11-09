// E2E page only (src/popup/e2e/e2e.html, built by tests/e2e/vite.e2e.config.ts, never part of the extension):
// opens the real popup code on a sample state and stands in for the service worker with timers, the way
// mockup/popup.html fakes it. Query: ?state=<name>&lang=en|th|auto&theme=system|light|dark&ui=en-US
import { type App, mountPopup } from '../app';
import type { Effect } from '../controller';
import { type Language, parseLanguagePref } from '../i18n';
import { i18nApi } from '../runtime';
import {
  account,
  baseState,
  EXTRA_STATES,
  type ExtraName,
  SAMPLE_PASSWORD,
  SAMPLE_STATES,
  type SampleName,
  SEED_NAMES,
  sampleState,
} from '../samples';
import { parseThemePref } from '../theme';

const params = new URLSearchParams(location.search);
const name = params.get('state') ?? 'list';
const lang = parseLanguagePref(params.get('lang'));
const ui = params.get('ui') ?? i18nApi.getUILanguage();
const uiLang: Language = ui.toLowerCase().startsWith('th') ? 'th' : 'en';
const theme = parseThemePref(params.get('theme'));
const hold = params.get('hold') === '1'; // keep a "switching" row on screen instead of finishing

const root = document.getElementById('app');
if (!root) throw new Error('missing #app');

const known = [...SAMPLE_STATES, ...EXTRA_STATES].includes(name as SampleName & ExtraName);
const shown = lang === 'auto' ? uiLang : lang;
// ?label=<text> gives every sample account that name (the right-to-left override test uses it)
const label = params.get('label');
if (label) for (const id of Object.keys(SEED_NAMES[shown])) SEED_NAMES[shown][id] = label;
const base = known
  ? sampleState(name as SampleName & ExtraName, shown, `Facebook 4`)
  : baseState(shown);
const state = {
  ...base,
  settings: { ...base.settings, theme, language: lang, uiLanguage: uiLang },
};

let nextId = 100;
let tail = 1000;
const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (fn: () => void, ms: number): void => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
};

function handle(effect: Effect, app: App): void {
  const s = app.state();
  switch (effect.type) {
    case 'switch': {
      if (hold) return;
      const view = s.platforms[effect.platform];
      const steps = effect.platform === 'youtube' ? 2 : 3;
      const expired = view.accounts.find((a) => a.id === effect.id)?.expired ?? false;
      for (let i = 1; i < steps; i++)
        later(() => app.dispatch({ type: 'switch-step', step: i }), 600 * i);
      later(() => {
        app.dispatch({ type: 'switch-done', ok: !expired });
        later(() => app.dispatch({ type: 'flash-clear' }), 1400);
        if (!expired) later(() => app.dispatch({ type: 'toast-clear' }), 4000);
      }, 600 * steps);
      return;
    }
    case 'probe-add':
      app.dispatch({
        type: 'add-probed',
        found:
          params.get('loggedIn') === '0'
            ? null
            : {
                idTail: String(++tail),
                defaultName: app.translator().text('add_defaultName', {
                  platform: effect.platform,
                  n: s.platforms[effect.platform].accounts.length + 1,
                }),
              },
      });
      return;
    case 'add': {
      const view = s.platforms[effect.platform];
      const previous = view.accounts.map((a) =>
        a.id === view.activeId ? { ...a, used: { kind: 'justNow' as const } } : a,
      );
      const created = account(`n${nextId++}`, effect.label, {
        sub:
          effect.platform === 'youtube'
            ? { kind: 'google', n: 2, brand: false }
            : { kind: 'id', tail: String(tail) },
        used: { kind: 'now' },
        expired: false,
      });
      app.dispatch({
        type: 'platform-loaded',
        platform: effect.platform,
        view: { ...view, accounts: [...previous, created], activeId: created.id },
      });
      return;
    }
    case 'unlock':
      later(() => {
        const ok = effect.password === SAMPLE_PASSWORD;
        app.dispatch({ type: 'unlock-result', ok });
        later(() => app.dispatch({ type: ok ? 'unlock-done' : 'unlock-reset' }), ok ? 450 : 1100);
      }, 500);
      return;
    default:
      return;
  }
}

mountPopup({ root, cache: localStorage, uiLanguage: ui, state, onEffect: handle });
document.documentElement.dataset.e2eReady = '1';
