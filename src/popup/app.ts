// Glue between the pure pieces: state ←→ reducer ←→ DOM. It owns the current state, translator and theme,
// listens for clicks/typing on the popup root, and wraps each redraw in the right view transition.
// It reaches nothing outside the DOM: the storage cache, the UI language and the effect handler are
// passed in, so unit tests (happy-dom) and the e2e page can drive the same code the extension runs.
import { type Effect, escapeTarget, type PopupAction, parseAction, reduce } from './controller';
import {
  createTranslator,
  type Language,
  parseLanguagePref,
  resolveLanguage,
  type Translator,
} from './i18n';
import { circleReveal, runTransition } from './motion';
import { syncSliders } from './slider';
import { writePlatformCache } from './start';
import { initialState, type Platform, type PopupState } from './state';
import {
  applyTheme,
  readThemeCache,
  reconcileTheme,
  type ThemeCache,
  writeThemeCache,
} from './theme';
import { patchHints, patchSwitchStep, renderPopup } from './view';

export const LANGUAGE_CACHE_KEY = 'language';

export interface AppDeps {
  root: HTMLElement;
  /** localStorage (or a fake). Null when storage is blocked. */
  cache: ThemeCache | null;
  /** chrome.i18n.getUILanguage(), for the Auto language choice. */
  uiLanguage: string;
  /** Start from this state instead of an empty one (the e2e page and tests use it). */
  state?: PopupState;
  /** First page to draw when no `state` is given (`loading` until the worker has answered). */
  startPage?: PopupState['page'];
  /** The platform tab to open on when no `state` is given (src/popup/start.ts picks it). */
  platform?: Platform;
  /** The platform whose site the browser tab under the popup shows, if any. */
  here?: Platform | null;
  /** Called for each thing the background has to do. B5b sends them to the service worker. */
  onEffect?: (effect: Effect, app: App) => void;
}

export interface App {
  dispatch(action: PopupAction, at?: { x: number; y: number }): void;
  state(): PopupState;
  translator(): Translator;
}

function readLanguageCache(cache: ThemeCache | null) {
  try {
    return parseLanguagePref(cache?.getItem(LANGUAGE_CACHE_KEY));
  } catch {
    return 'auto';
  }
}

function writeLanguageCache(cache: ThemeCache | null, value: string): void {
  try {
    cache?.setItem(LANGUAGE_CACHE_KEY, value);
  } catch {
    // only a cache
  }
}

const CHARS: Record<string, 'rename' | 'add' | 'password'> = {
  'rename-input': 'rename',
  'add-input': 'add',
  'pw-input': 'password',
};

export function mountPopup(deps: AppDeps): App {
  const { root, cache } = deps;
  const doc = root.ownerDocument;
  const html = doc.documentElement;
  const uiLanguage: Language = resolveLanguage('auto', deps.uiLanguage);

  let state: PopupState = deps.state ?? initialState();
  if (!deps.state) {
    state = {
      ...state,
      settings: {
        ...state.settings,
        theme: readThemeCache(cache),
        language: readLanguageCache(cache),
      },
    };
  }
  state = { ...state, settings: { ...state.settings, uiLanguage } };
  if (!deps.state && deps.startPage) state = { ...state, page: deps.startPage };
  // chosen before the first draw, so the popup never slides from one tab to another on its own
  if (!deps.state && deps.platform) state = { ...state, platform: deps.platform };
  if (!deps.state && deps.here)
    state = { ...state, here: { platform: deps.here, accountId: null } };
  reconcileTheme(html, cache, state.settings.theme);
  let tr = createTranslator(resolveLanguage(state.settings.language, deps.uiLanguage));

  // Set by Esc: after the next redraw, focus goes back to the button that opened what was closed.
  let returnFocusTo: string | null = null;

  const draw = (): void => {
    html.lang = tr.lang;
    html.dataset.lang = tr.lang;
    doc.title = tr.text('popupTitle');
    renderPopup(root, state, tr);
    syncSliders(root);
    if (returnFocusTo) {
      root.querySelector<HTMLElement>(returnFocusTo)?.focus();
      returnFocusTo = null;
    }
  };

  const app: App = {
    state: () => state,
    translator: () => tr,
    dispatch(action, at) {
      const prev = state;
      const step = reduce(prev, action);
      state = step.state;
      const themeChanged = state.settings.theme !== prev.settings.theme;
      const langChanged =
        state.settings.language !== prev.settings.language ||
        state.settings.uiLanguage !== prev.settings.uiLanguage;

      // only a tab the person picked is remembered, never one picked for them
      if (action.type === 'tab' && state.platform !== prev.platform)
        writePlatformCache(cache, state.platform);

      const update = (): void => {
        if (themeChanged) {
          applyTheme(html, state.settings.theme);
          writeThemeCache(cache, state.settings.theme);
        }
        if (langChanged) {
          tr = createTranslator(resolveLanguage(state.settings.language, deps.uiLanguage));
          writeLanguageCache(cache, state.settings.language);
        }
        draw();
      };

      if (themeChanged && action.type === 'pref-theme') {
        const x = at?.x ?? html.clientWidth / 2;
        const y = at?.y ?? html.clientHeight / 2;
        circleReveal(x, y, update);
      } else if (step.render || themeChanged || langChanged) {
        const mode = langChanged && action.type === 'pref-language' ? 'lang' : step.mode;
        runTransition(mode, update, { dir: step.dir });
      } else if (action.type === 'switch-step') {
        patchSwitchStep(root, state, tr);
      } else {
        patchHints(root, state, tr);
      }
      for (const effect of step.effects) deps.onEffect?.(effect, app);
    },
  };

  root.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const el = target.closest<HTMLElement>('[data-act],[data-tab],[data-pref]');
    if (!el || (el instanceof HTMLButtonElement && el.disabled)) return;
    const action = parseAction(el);
    if (!action) return;
    const rect = el.getBoundingClientRect();
    app.dispatch(action, {
      x: ev.clientX || rect.left + rect.width / 2,
      y: ev.clientY || rect.top + rect.height / 2,
    });
  });

  root.addEventListener('keydown', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = CHARS[target.id];
    if (ev.key === 'Enter') {
      if (field === 'rename') app.dispatch({ type: 'rename-save' });
      else if (field === 'add') app.dispatch({ type: 'add-save' });
      else if (field === 'password')
        app.dispatch({ type: state.page === 'setup' ? 'setup' : 'unlock' });
    }
  });

  // Esc is one rule for every control inside the popup, whatever has focus (see escapeTarget).
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const closing = escapeTarget(state);
    if (!closing) return;
    ev.preventDefault();
    returnFocusTo = closing.focus;
    app.dispatch(closing.action);
  });

  root.addEventListener('input', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = CHARS[target.id];
    if (field) app.dispatch({ type: 'input', field, value: target.value });
  });

  draw();
  return app;
}
