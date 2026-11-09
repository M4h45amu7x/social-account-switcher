import { describe, expect, test } from 'bun:test';
import { esc, html, raw } from '../../src/popup/html';

describe('html builder', () => {
  test('escapes interpolated text, including quotes', () => {
    expect(html`<p title="${'a"b'}">${"<b>&'</b>"}</p>`.value).toBe(
      '<p title="a&quot;b">&lt;b&gt;&amp;&#39;&lt;/b&gt;</p>',
    );
  });

  test('raw and nested html are not escaped twice', () => {
    expect(html`<i>${raw('<b>x</b>')}${html`<u>${'<'}</u>`}</i>`.value).toBe(
      '<i><b>x</b><u>&lt;</u></i>',
    );
    expect(String(raw('<b>'))).toBe('<b>');
  });

  test('false, null and undefined print nothing; arrays are joined', () => {
    expect(html`a${false}b${null}c${undefined}d`.value).toBe('abcd');
    expect(html`${['<', html`<i></i>`, 3]}`.value).toBe('&lt;<i></i>3');
  });

  test('esc turns non-strings into text', () => {
    expect(esc(42)).toBe('42');
  });
});
