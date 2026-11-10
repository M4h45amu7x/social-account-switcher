// Shared slide indicator for platform tabs and Settings controls. Platform tabs park at the measured
// selected button; Settings park in equal CSS slots. After redraw, animate from the previous geometry
// behind the labels. Reduced motion parks immediately without an animation.
import { prefersReducedMotion, tokenMs } from './motion';

/** The selected slot each track showed at the last draw, by `data-slide` key. */
const lastSlot = new Map<string, number>();
const lastBox = new Map<string, { left: number; width: number }>();

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
    if (!thumb) continue;
    const selected = track.querySelector<HTMLElement>(':scope > .tab[aria-selected="true"]');
    if (selected) {
      const rect = selected.getBoundingClientRect();
      const parent = track.getBoundingClientRect();
      const box = { left: rect.left - parent.left, width: rect.width };
      const old = lastBox.get(key);
      lastBox.set(key, box);
      thumb.style.left = `${box.left}px`;
      thumb.style.width = `${box.width}px`;
      thumb.style.transform = 'none';
      if (old && before !== now && !prefersReducedMotion() && typeof thumb.animate === 'function') {
        thumb.animate(
          [
            { translate: `${old.left - box.left}px 0`, width: `${old.width}px` },
            { translate: '0 0', width: `${box.width}px` },
          ],
          {
            duration: tokenMs('--dur-slow', 420),
            easing: getComputedStyle(track).getPropertyValue('--ease-out').trim() || 'ease-out',
          },
        );
      }
      continue;
    }
    if (before === undefined || before === now) continue;
    if (prefersReducedMotion() || typeof thumb.animate !== 'function') continue;
    // one slot = the thumb's width plus the gap; `translate` is separate from the CSS `transform` that parks it
    const step = thumb.offsetWidth + (Number.parseFloat(getComputedStyle(track).columnGap) || 0);
    thumb.animate([{ translate: `${(before - now) * step}px 0` }, { translate: '0 0' }], {
      duration: tokenMs('--dur-slow', 420),
      easing: getComputedStyle(track).getPropertyValue('--ease-out').trim() || 'ease-out',
    });
  }
  // a track that is not on screen any more starts fresh the next time it appears
  for (const key of [...lastSlot.keys()])
    if (!seen.has(key)) {
      lastSlot.delete(key);
      lastBox.delete(key);
    }
}

/** For tests: forget where every track was. */
export function resetSliders(): void {
  lastSlot.clear();
  lastBox.clear();
}
