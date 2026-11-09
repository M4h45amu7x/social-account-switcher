// Popup strings. chrome.i18n can only answer in the browser's UI language, but the popup lets the user
// pick a language of their own, so both catalogs are bundled at build time and read here. They are the
// same files Chrome reads for the manifest (public/_locales), in Chrome's own format:
// `$NAME$` placeholders, and `[[text]]` marks a bold run (turned into <b> only after escaping).
import enCatalog from '../../public/_locales/en/messages.json';
import thCatalog from '../../public/_locales/th/messages.json';
import { esc, raw, type Safe } from './html';

export type Language = 'en' | 'th';
export type LanguagePref = 'auto' | Language;
export type MessageKey = keyof typeof enCatalog;
export type Params = Record<string, string | number>;

interface Entry {
  message: string;
}
type Catalog = Record<string, Entry>;

export const CATALOGS: Record<Language, Catalog> = { en: enCatalog, th: thCatalog };
export const LANGUAGES: readonly Language[] = ['en', 'th'];

/** Auto follows the browser UI language by its first part ("th-TH" → th); anything else is English. */
export function resolveLanguage(pref: LanguagePref, uiLanguage: string): Language {
  if (pref !== 'auto') return pref;
  return uiLanguage.toLowerCase().split(/[-_]/)[0] === 'th' ? 'th' : 'en';
}

export function parseLanguagePref(value: unknown): LanguagePref {
  return value === 'en' || value === 'th' ? value : 'auto';
}

// Private-use markers stand in for [[ and ]] while placeholders are filled, so a value that happens to
// contain "[[" can never turn into bold text.
const OPEN = '\u0001';
const CLOSE = '\u0002';

const FSI = '\u2068';
const PDI = '\u2069';

/**
 * Wraps user-typed text in a Unicode bidi isolate, so a right-to-left run or an override character in an
 * account name cannot reorder the words around it. Isolate controls inside the text are dropped first, or
 * the name could close its own isolate.
 */
export function isolate(text: string): string {
  return `${FSI}${text.replace(/[\u2066-\u2069]/g, '')}${PDI}`;
}

/** Fills `$NAME$` placeholders (and `$$`) from `params` and keeps the bold markers. */
function fill(message: string, params: Params): string {
  const marked = message.replace(/\[\[(.+?)\]\]/g, `${OPEN}$1${CLOSE}`);
  return marked.replace(/\$(\$|[A-Za-z0-9_@]+\$)/g, (token, name: string) => {
    if (name === '$') return '$';
    const key = name.slice(0, -1).toLowerCase();
    const value = params[key];
    if (value === undefined) return token;
    const text = String(value).replaceAll(OPEN, '').replaceAll(CLOSE, '');
    return key === 'name' ? isolate(text) : text;
  });
}

export interface Translator {
  readonly lang: Language;
  /** Plain text: for attributes, titles and `textContent`. Bold markers are dropped. */
  text(key: MessageKey, params?: Params): string;
  /** Safe markup: escaped, with [[bold]] turned into <b>. */
  html(key: MessageKey, params?: Params): Safe;
  /** Plural text for `<base>_one` / `<base>_other` with {n}. */
  count(base: 'tabs', n: number): string;
}

export function createTranslator(lang: Language): Translator {
  const lookup = (key: MessageKey, params: Params = {}): string => {
    const entry = CATALOGS[lang][key] ?? CATALOGS.en[key];
    return fill(entry?.message ?? key, params);
  };
  const plural = new Intl.PluralRules(lang);
  return {
    lang,
    text: (key, params) => lookup(key, params).replaceAll(OPEN, '').replaceAll(CLOSE, ''),
    html: (key, params) =>
      raw(esc(lookup(key, params)).replaceAll(OPEN, '<b>').replaceAll(CLOSE, '</b>')),
    count: (base, n) => {
      const key = `${base}_${plural.select(n)}` as MessageKey;
      const resolved = key in CATALOGS[lang] ? key : (`${base}_other` as MessageKey);
      return lookup(resolved, { n }).replaceAll(OPEN, '').replaceAll(CLOSE, '');
    },
  };
}
