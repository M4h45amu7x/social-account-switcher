// Interfaces for every browser API the extension uses (docs/design.md 8.2).
// Logic receives these as parameters, so it can be unit-tested with fakes, and every async method is
// typed as returning a Promise here. That is what lets Biome's noFloatingPromises catch a missing
// `await`: Biome does not infer return types from @types/chrome, so `chrome` is banned outside the
// adapter files (src/background/chrome-adapter.ts, src/popup/runtime.ts).
//
// What `bun run lint` catches outside the adapters:
//   - Biome: the globals chrome, globalThis, self, window, frames, parent and top, so `chrome.x`,
//     `globalThis.chrome`, `self['chrome']`, `const { chrome } = window` and `const g = globalThis`.
//   - scripts/check-chrome-access.ts: any `chrome` word left after comments and types are stripped,
//     including strings and `document.defaultView.chrome`.
// It does not catch a name built at runtime (`self['ch' + 'rome']`) or eval-like code. That is left to
// code review. Samples of each case live in tests/lint-fixtures/.
// Later cards add CookiesApi, LocalStorageApi, TabsApi and ScriptingApi here.

export type SessionAccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';

export interface SessionStorageApi {
  setAccessLevel(options: { accessLevel: SessionAccessLevel }): Promise<void>;
}

export interface LifecycleApi {
  /** Runs `handler` when the extension is installed or updated, and when the browser starts. */
  onInstalledOrStartup(handler: () => void): void;
}

export interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
  getUILanguage(): string;
}
