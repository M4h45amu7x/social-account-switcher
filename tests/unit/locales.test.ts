import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

type Messages = Record<string, { message: string; placeholders?: Record<string, unknown> }>;

const dir = new URL('../../public/_locales/', import.meta.url);
const load = (locale: string): Messages =>
  JSON.parse(readFileSync(new URL(`${locale}/messages.json`, dir), 'utf8')) as Messages;
const manifest = JSON.parse(
  readFileSync(new URL('../../src/manifest.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const en = load('en');
const locales = readdirSync(dir);

describe('locales', () => {
  test('default_locale is en and its folder exists', () => {
    expect(manifest.default_locale).toBe('en');
    expect(locales).toContain('en');
    expect(locales).toContain('th');
  });

  test('every __MSG_x__ in the manifest exists in en', () => {
    const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1] ?? '');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(en[key]?.message).toBeTruthy();
  });

  for (const locale of locales) {
    test(`${locale}: same keys and placeholders as en`, () => {
      const messages = load(locale);
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const [key, value] of Object.entries(en)) {
        expect(Object.keys(messages[key]?.placeholders ?? {})).toEqual(
          Object.keys(value.placeholders ?? {}),
        );
        expect(messages[key]?.message.includes('$VERSION$')).toBe(
          value.message.includes('$VERSION$'),
        );
      }
    });

    test(`${locale}: Web Store length limits`, () => {
      const messages = load(locale);
      expect(messages.extName?.message.length ?? 0).toBeLessThanOrEqual(45);
      expect(messages.extDescription?.message.length ?? 0).toBeLessThanOrEqual(132);
    });
  }
});
