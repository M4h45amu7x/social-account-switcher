// The slide indicator shared by the platform tabs and the Settings segmented controls (Theme, Language).
// The view draws every track as `<div class="slide" data-slide="key" style="--n:3;--i:1">` holding a
// `<span class="thumb">` and the buttons; the thumb sits at slot --i by CSS alone, behind the labels. This module
// only adds the glide: after a redraw, a track whose selected slot changed animates its thumb from the old slot to
// the new one. Nothing here draws on top of a label, and with prefers-reduced-motion the thumb is simply there.
import { prefersReducedMotion, tokenMs } from './motion';

/** The selected slot each track showed at the last draw, by `data-slide` key. */
const lastSlot = new Map<string, number>();

/** Call after every draw. `root` holds the freshly drawn popup. */
export function syncSliders(root: ParentNode): void {
  const seen = new Set<string>();
  for (const track of root.querySelectorAll<HTMLElement>('.slide[data-slide]')) {
    const key = track.dataset.slide ?? '';
    const now = Number(track.style.getPropertyValue('--i'));
    const before = lastSlot.get(key);
    seen.add(key);
    lastSlot.set(key, now);
    const thumb = track.querySelector<HTMLElement>(':scope > .thumb');
    if (!thumb || before === undefined || before === now) continue;
    if (prefersReducedMotion() || typeof thumb.animate !== 'function') continue;
    // one slot = the thumb's width plus the gap; `translate` is separate from the CSS `transform` that parks it
    const step = thumb.offsetWidth + (Number.parseFloat(getComputedStyle(track).columnGap) || 0);
    thumb.animate([{ translate: `${(before - now) * step}px 0` }, { translate: '0 0' }], {
      duration: tokenMs('--dur-slow', 420),
      easing: getComputedStyle(track).getPropertyValue('--ease-out').trim() || 'ease-out',
    });
  }
  // a track that is not on screen any more starts fresh the next time it appears
  for (const key of [...lastSlot.keys()]) if (!seen.has(key)) lastSlot.delete(key);
}

/** For tests: forget where every track was. */
export function resetSliders(): void {
  lastSlot.clear();
}
