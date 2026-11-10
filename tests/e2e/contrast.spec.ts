// Permanent contrast gate (WCAG 2.2 AA), card B5a rework. Every screen of the real popup, in en and th, in
// light and dark, is opened and measured in Chromium:
//   - every visible text node: >= 4.5:1 (>= 3:1 for large text), against the real stacked background
//   - placeholders: >= 4.5:1
//   - icon-only buttons and the check/cross badges: >= 3:1
//   - text-field borders and the focus colour: >= 3:1 against the surface they sit on
// Disabled controls and the dimmed rows during a switch are exempt (WCAG 1.4.3 inactive components).
// One failing point anywhere fails the run; the message names the screen, the text and the ratio.
import { EXTRA_STATES, SAMPLE_STATES } from '../../src/popup/samples';
import { buildPopup, open, popupTest as test } from './popup-build';

const { expect } = test;
const LANGS = ['en', 'th'] as const;
const THEMES = ['light', 'dark'] as const;
const STATES = [...SAMPLE_STATES, ...EXTRA_STATES];

test.beforeAll(() => buildPopup());

/** Runs inside the page. Returns one line per violation. */
function measure(): string[] {
  const MIN_TEXT = 4.5; // a function sent to the page cannot see module constants
  const MIN_NON_TEXT = 3;
  type Rgba = [number, number, number, number];
  const parse = (c: string): Rgba | null => {
    const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/);
    if (!m?.[1]) return null;
    const p = m[1].split(/[ ,/]+/).map(Number);
    const k = c.startsWith('color(') ? 255 : 1;
    return [(p[0] ?? 0) * k, (p[1] ?? 0) * k, (p[2] ?? 0) * k, p[3] ?? 1];
  };
  const channel = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: number[]) =>
    0.2126 * channel(c[0] ?? 0) + 0.7152 * channel(c[1] ?? 0) + 0.0722 * channel(c[2] ?? 0);
  const ratio = (a: number[], b: number[]) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (top: Rgba, under: number[]) =>
    [0, 1, 2].map((i) => (top[i] ?? 0) * top[3] + (under[i] ?? 0) * (1 - top[3]));
  /** The colour behind `el`: stacked ancestor backgrounds, composited from the page background up. */
  const backdrop = (el: Element): number[] => {
    const chain: Rgba[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) {
        chain.push(c);
        if (c[3] === 1) break;
      }
      // the selected slot of a tab bar / segmented control sits on its thumb, drawn between the button and the track
      const thumb = e.parentElement?.querySelector(':scope > .thumb');
      if (thumb && e.matches('[aria-selected="true"], [aria-pressed="true"]')) {
        const t = parse(getComputedStyle(thumb).backgroundColor);
        if (t && t[3] > 0) {
          chain.push(t);
          if (t[3] === 1) break;
        }
      }
    }
    let acc: number[] = [255, 255, 255];
    for (const c of chain.reverse()) acc = over(c, acc);
    return acc;
  };
  const exempt = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return true;
    if (el.closest('.sr')) return true;
    const btn = el.closest('button, input') as HTMLButtonElement | null;
    if (btn?.disabled) return true;
    return !!el.closest('.list.dim') && !el.closest('.busy');
  };

  const bad: string[] = [];
  const app = document.getElementById('app');
  if (!app) return ['no #app'];
  const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 40);

  const walker = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').trim();
    const el = n.parentElement;
    if (!text || !el || exempt(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const r = ratio(over(fg, bg), bg);
    const size = Number.parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    if (r < (large ? 3 : MIN_TEXT))
      bad.push(`text ${r.toFixed(2)} "${text.slice(0, 28)}" ${name(el)}`);
  }
  for (const input of app.querySelectorAll<HTMLInputElement>('input')) {
    if (exempt(input)) continue;
    const bg = backdrop(input);
    if (input.placeholder && !input.value) {
      const fg = parse(getComputedStyle(input, '::placeholder').color);
      if (fg) {
        const r = ratio(over(fg, bg), bg);
        if (r < MIN_TEXT) bad.push(`placeholder ${r.toFixed(2)} "${input.placeholder}"`);
      }
    }
  }
  // the field outline: the input itself, or the .pw wrapper that draws the password box
  for (const box of app.querySelectorAll<HTMLElement>('.edit input, .pw')) {
    const cs = getComputedStyle(box);
    const line = parse(cs.borderTopColor);
    const outer = backdrop(box.parentElement ?? box);
    if (!line || Number.parseFloat(cs.borderTopWidth) === 0) {
      bad.push(`field has no border ${name(box)}`);
      continue;
    }
    if (box.classList.contains('bad')) continue; // the error colour is measured as a non-text colour below
    const r = ratio(over(line, outer), outer);
    if (r < MIN_NON_TEXT) bad.push(`field border ${r.toFixed(2)} ${name(box)}`);
  }
  for (const box of app.querySelectorAll<HTMLElement>('.pw.bad')) {
    const line = parse(getComputedStyle(box).borderTopColor);
    const outer = backdrop(box.parentElement ?? box);
    if (line && ratio(over(line, outer), outer) < MIN_NON_TEXT) bad.push('error field border');
  }
  // icons: icon-only buttons draw with currentColor; the result badges draw white-ish on a filled disc
  for (const b of app.querySelectorAll<HTMLElement>('button.icon-btn, .flash, .toast .ok')) {
    if (exempt(b) || !b.querySelector('svg')) continue;
    const fg = parse(getComputedStyle(b).color);
    const bg = backdrop(b);
    if (fg && ratio(over(fg, bg), bg) < MIN_NON_TEXT) {
      bad.push(`icon ${ratio(over(fg, bg), bg).toFixed(2)} ${name(b)}`);
    }
  }
  // the focus ring is drawn with --focus on whatever the control sits on
  const focus = parse(
    getComputedStyle(document.documentElement).getPropertyValue('--focus').trim().startsWith('#')
      ? hexToRgb(getComputedStyle(document.documentElement).getPropertyValue('--focus').trim())
      : getComputedStyle(document.documentElement).getPropertyValue('--focus'),
  );
  if (focus) {
    for (const c of ['--surface', '--surface-2']) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(c).trim();
      const bgc = parse(raw.startsWith('#') ? hexToRgb(raw) : raw);
      if (bgc && ratio(focus, bgc) < MIN_NON_TEXT) bad.push(`focus ring on ${c}`);
    }
  }
  function hexToRgb(h: string): string {
    const v = h.replace('#', '');
    const f = v.length === 3 ? v.replace(/./g, (x) => x + x) : v;
    return `rgb(${Number.parseInt(f.slice(0, 2), 16)}, ${Number.parseInt(f.slice(2, 4), 16)}, ${Number.parseInt(f.slice(4, 6), 16)})`;
  }
  return bad;
}

test.describe('contrast gate: every screen × en/th × light/dark', () => {
  test.use({ viewport: { width: 360, height: 800 } });
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      test(`${lang} · ${theme}: all ${STATES.length} screens pass WCAG 2.2 AA`, async ({
        context,
        extensionId,
      }) => {
        const page = await context.newPage();
        const failures: string[] = [];
        for (const state of STATES) {
          await open(page, extensionId, { state, lang, theme });
          for (const line of await page.evaluate(measure))
            failures.push(`${lang}/${theme}/${state}: ${line}`);
        }
        expect(failures, `${failures.length} contrast problem(s)`).toEqual([]);
      });
    }
  }
});
