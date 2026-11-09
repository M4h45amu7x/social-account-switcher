import { describe, expect, test } from 'bun:test';
import {
  CATALOGS,
  createTranslator,
  isolate,
  type MessageKey,
  parseLanguagePref,
  resolveLanguage,
} from '../../src/popup/i18n';

describe('resolveLanguage', () => {
  test('an explicit choice wins over the browser language', () => {
    expect(resolveLanguage('en', 'th-TH')).toBe('en');
    expect(resolveLanguage('th', 'en-US')).toBe('th');
  });

  test('Auto follows the first part of the browser UI language; everything else is English', () => {
    expect(resolveLanguage('auto', 'th')).toBe('th');
    expect(resolveLanguage('auto', 'th-TH')).toBe('th');
    expect(resolveLanguage('auto', 'TH_th')).toBe('th');
    expect(resolveLanguage('auto', 'en-GB')).toBe('en');
    expect(resolveLanguage('auto', 'de')).toBe('en');
    expect(resolveLanguage('auto', '')).toBe('en');
  });

  test('parseLanguagePref falls back to auto', () => {
    expect(parseLanguagePref('th')).toBe('th');
    expect(parseLanguagePref('en')).toBe('en');
    expect(parseLanguagePref('fr')).toBe('auto');
    expect(parseLanguagePref(null)).toBe('auto');
  });
});

describe('translator', () => {
  const en = createTranslator('en');
  const th = createTranslator('th');
  // names are wrapped in bidi isolates (tested below); the other tests compare the visible text
  const plain = (s: string): string => s.replace(/[\u2068\u2069]/g, '');

  test('fills $NAME$ placeholders by name', () => {
    expect(plain(en.text('row_switchTo', { name: 'Shop' }))).toBe('Switch to Shop');
    expect(plain(th.text('row_switchTo', { name: 'ร้าน' }))).toBe('สลับเป็น ร้าน');
    expect(en.text('list_label', { platform: 'Facebook', n: 3 })).toBe('Facebook accounts (3)');
  });

  test('a missing parameter leaves the token visible instead of printing "undefined"', () => {
    expect(plain(en.text('row_switchTo'))).toBe('Switch to $NAME$');
  });

  test('[[bold]] becomes <b> in html() and disappears in text()', () => {
    expect(plain(en.html('toast_switched', { name: 'Shop' }).value)).toBe(
      'Switched to <b>Shop</b>',
    );
    expect(plain(en.text('toast_switched', { name: 'Shop' }))).toBe('Switched to Shop');
  });

  test('html() escapes parameters, and a parameter cannot add bold markers', () => {
    const out = en.html('toast_switched', { name: '<img src=x onerror=1>[[evil]]' }).value;
    expect(plain(out)).toBe('Switched to <b>&lt;img src=x onerror=1&gt;[[evil]]</b>');
    expect(plain(en.text('row_switchTo', { name: '\u0001x\u0002' }))).toBe('Switch to x');
  });

  test('plural: tabs_one / tabs_other in English, one form in Thai', () => {
    expect(en.count('tabs', 1)).toBe('1 tab');
    expect(en.count('tabs', 2)).toBe('2 tabs');
    expect(en.count('tabs', 0)).toBe('0 tabs');
    expect(th.count('tabs', 1)).toBe('1 แท็บ');
    expect(th.count('tabs', 5)).toBe('5 แท็บ');
  });

  test('an unknown key shows the key itself so a typo is visible', () => {
    expect(en.text('nope_nothing' as MessageKey)).toBe('nope_nothing');
  });

  test('$$ is a literal dollar sign, like in chrome.i18n', () => {
    const catalog = CATALOGS.en as Record<string, { message: string }>;
    catalog.test_price = { message: 'Cost $$5 for $NAME$' };
    try {
      expect(plain(en.text('test_price' as MessageKey, { name: 'Pro' }))).toBe('Cost $5 for Pro');
    } finally {
      delete catalog.test_price;
    }
  });

  test('a key missing in Thai falls back to the English text', () => {
    const catalog = CATALOGS.en as Record<string, { message: string }>;
    catalog.test_only_en = { message: 'Only English' };
    try {
      expect(th.text('test_only_en' as MessageKey)).toBe('Only English');
    } finally {
      delete catalog.test_only_en;
    }
  });
});

describe('catalogs', () => {
  test('no Thai string still contains a { } placeholder from the mockup tables', () => {
    for (const lang of ['en', 'th'] as const) {
      for (const [key, entry] of Object.entries(CATALOGS[lang])) {
        expect(`${key}: ${entry.message}`).not.toMatch(/[{}]/);
      }
    }
  });

  test('Thai strings reviewed by kru-thai are in place', () => {
    const th = createTranslator('th');
    expect(th.text('used_hoursAgo', { n: 2 })).toBe('ใช้เมื่อ 2 ชม. ก่อน');
    expect(th.text('sub_google', { n: 1 })).toBe('บัญชี Google ที่ 1');
    expect(th.text('toast_reloaded', { tabs: '2 แท็บ' })).toBe('รีโหลด 2 แท็บ แล้ว');
    expect(th.text('lock_sub')).toContain('ปลดล็อกครั้งเดียว');
  });
});

describe('bidi isolation of user-typed names', () => {
  const en = createTranslator('en');
  const FSI = '⁨';
  const PDI = '⁩';

  test('the name parameter is wrapped in a Unicode isolate in text and html', () => {
    expect(en.text('row_switchTo', { name: 'Shop' })).toBe(`Switch to ${FSI}Shop${PDI}`);
    expect(en.html('delete_title', { name: 'Shop' }).value).toBe(
      `Remove <b>“${FSI}Shop${PDI}”</b> from the list?`,
    );
  });

  test('a right-to-left override stays inside its isolate', () => {
    const out = en.text('row_switchTo', { name: '‮abc' });
    expect(out.startsWith(`Switch to ${FSI}`)).toBe(true);
    expect(out.endsWith(PDI)).toBe(true);
    expect(isolate('‮abc')).toBe(`${FSI}‮abc${PDI}`);
  });

  test('isolate controls typed into a name are removed so it cannot close its own isolate', () => {
    expect(isolate(`a${PDI}b${FSI}c⁦d⁧`)).toBe(`${FSI}abcd${PDI}`);
    const out = en.text('row_switchTo', { name: `x${PDI}y` });
    expect(out).toBe(`Switch to ${FSI}xy${PDI}`);
  });

  test('other parameters (platform, site, counts) are not wrapped', () => {
    expect(en.text('list_label', { platform: 'Facebook', n: 3 })).toBe('Facebook accounts (3)');
  });
});
