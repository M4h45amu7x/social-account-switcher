// The slide indicator shared by the tabs and the Settings segmented controls (src/popup/slider.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTranslator } from '../../src/popup/i18n';
import { baseState } from '../../src/popup/samples';
import { resetSliders, syncSliders } from '../../src/popup/slider';
import { renderPopup } from '../../src/popup/view';

type Keyframes = Record<string, string>[];
let calls: { keyframes: Keyframes; options: KeyframeAnimationOptions }[] = [];
const original = globalThis.matchMedia;
const setReduced = (on: boolean): void => {
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: on && q.includes('prefers-reduced-motion'),
  });
};

/** happy-dom has no layout: give every thumb a width so a slot has a size. */
function track(key: string, slot: number, n = 3): HTMLElement {
  const el = document.createElement('div');
  el.className = 'slide';
  el.dataset.slide = key;
  el.style.setProperty('--n', String(n));
  el.style.setProperty('--i', String(slot));
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  Object.defineProperty(thumb, 'offsetWidth', { value: 100 });
  (thumb as unknown as { animate: unknown }).animate = (
    keyframes: Keyframes,
    options: KeyframeAnimationOptions,
  ) => {
    calls.push({ keyframes, options });
  };
  el.append(thumb);
  return el;
}

beforeEach(() => {
  calls = [];
  resetSliders();
  setReduced(false);
  document.body.innerHTML = '';
});
afterEach(() => {
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = original;
});

describe('syncSliders', () => {
  test('the first draw only parks the thumb; a changed slot glides from the old one', () => {
    document.body.append(track('tabs', 0));
    syncSliders(document.body);
    expect(calls).toHaveLength(0);
    document.body.replaceChildren(track('tabs', 2));
    syncSliders(document.body);
    expect(calls).toHaveLength(1);
    // two slots to the right: it starts 2 x 100px (+ gap 0 in this fake layout) to the left of where it is parked
    expect(calls[0]?.keyframes).toEqual([{ translate: '-200px 0' }, { translate: '0 0' }]);
    expect(calls[0]?.options.duration).toBeGreaterThan(0);
  });

  test('the same slot, or another control, does not move', () => {
    document.body.append(track('tabs', 1), track('theme', 0));
    syncSliders(document.body);
    document.body.replaceChildren(track('tabs', 1), track('theme', 0));
    syncSliders(document.body);
    expect(calls).toHaveLength(0);
  });

  test('every control moves on its own key (tabs, theme and language together)', () => {
    document.body.append(track('tabs', 0), track('theme', 0), track('language', 0));
    syncSliders(document.body);
    document.body.replaceChildren(track('tabs', 1), track('theme', 2), track('language', 0));
    syncSliders(document.body);
    expect(calls).toHaveLength(2);
  });

  test('prefers-reduced-motion: no animation at all, the thumb is just at its slot', () => {
    document.body.append(track('tabs', 0));
    syncSliders(document.body);
    setReduced(true);
    document.body.replaceChildren(track('tabs', 2));
    syncSliders(document.body);
    expect(calls).toHaveLength(0);
  });

  test('a track that left the screen starts fresh when it comes back', () => {
    document.body.append(track('language', 0));
    syncSliders(document.body);
    document.body.replaceChildren();
    syncSliders(document.body);
    document.body.append(track('language', 2));
    syncSliders(document.body);
    expect(calls).toHaveLength(0);
  });

  test('a browser without Element.animate just shows the thumb in place', () => {
    document.body.append(track('tabs', 0));
    syncSliders(document.body);
    const next = track('tabs', 1);
    (next.querySelector('.thumb') as unknown as { animate: unknown }).animate = undefined;
    document.body.replaceChildren(next);
    syncSliders(document.body);
    expect(calls).toHaveLength(0);
  });
});

describe('the view draws the same indicator for the tabs and every segmented control', () => {
  test('tabs and the Theme / Language segments carry --n, --i and a thumb behind the buttons', () => {
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    const s = baseState('en');
    renderPopup(root, { ...s, platform: 'instagram' }, createTranslator('en'));
    const tabs = root.querySelector<HTMLElement>('.tabs.slide');
    expect(tabs?.dataset.slide).toBe('tabs');
    expect(tabs?.style.getPropertyValue('--n')).toBe('3');
    expect(tabs?.style.getPropertyValue('--i')).toBe('1');
    expect(tabs?.firstElementChild?.className).toBe('thumb');
    expect(root.querySelector('.pill')).toBeNull();

    renderPopup(
      root,
      { ...s, page: 'settings', settings: { ...s.settings, theme: 'dark', language: 'th' } },
      createTranslator('en'),
    );
    const seg = (key: string) => root.querySelector<HTMLElement>(`.seg.slide[data-slide="${key}"]`);
    expect(seg('theme')?.style.getPropertyValue('--i')).toBe('2');
    expect(seg('language')?.style.getPropertyValue('--i')).toBe('2');
    expect(seg('language')?.style.getPropertyValue('--n')).toBe('3');
    for (const key of ['theme', 'language']) {
      expect(seg(key)?.firstElementChild?.className).toBe('thumb');
      expect(seg(key)?.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
    }
  });
});
