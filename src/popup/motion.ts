// Motion with the View Transitions API (docs/design.md section 12). No dependency.
// run(mode, update) wraps one DOM update. The browser snapshots the page, `update` changes the DOM, and
// the stylesheet's ::view-transition-* rules (popup.css) animate old → new, picked by <html data-vt>.
// Without the API, or with prefers-reduced-motion: reduce, `update` simply runs.

export type MotionMode =
  | 'theme'
  | 'tab'
  | 'list'
  | 'status'
  | 'expand'
  | 'page'
  | 'toast'
  | 'lang'
  | 'none';

export interface MotionOptions {
  /** Slide direction for tab/page changes: 1 = forward, -1 = back. */
  dir?: 1 | -1;
}

type Matcher = readonly [
  selector: string,
  name: (el: HTMLElement) => string,
  cls: string,
  modes: readonly (MotionMode | '*')[],
];

// Which elements get a view-transition-name (a stable identity across the DOM swap) in which mode.
const NAMED: readonly Matcher[] = [
  ['.row[data-id]', (el) => `row-${el.dataset.id}`, 'row', ['list', 'status', 'expand']],
  ['.slot[data-id]', (el) => `slot-${el.dataset.id}`, 'slot', ['list', 'status', 'expand']],
  ['[data-panel]', () => 'panel', 'panel', ['tab', 'page']],
  ['[data-card]', (el) => `card-${el.dataset.card}`, 'card', ['expand']],
  ['[data-sbtn]', () => 'sbtn', 'sbtn', ['status']],
  ['.toast', () => 'toast', 'toast', ['*']],
];

export function applyNames(mode: MotionMode, scope: ParentNode = document): void {
  for (const [selector, name, cls, modes] of NAMED) {
    const on = modes.includes('*') || modes.includes(mode);
    for (const el of scope.querySelectorAll<HTMLElement>(selector)) {
      el.style.viewTransitionName = on ? name(el) : '';
      el.style.viewTransitionClass = on ? cls : '';
    }
  }
}

export function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A duration token is a calc() string, so let the browser resolve it through a throw-away element. */
export function tokenMs(name: string, fallback: number): number {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;visibility:hidden;transition-duration:var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).transitionDuration;
  probe.remove();
  const ms = value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

let sequence = 0;

/** Runs `update` inside a view transition. Returns the transition, or null when `update` ran directly. */
export function runTransition(
  mode: MotionMode,
  update: () => void,
  opts: MotionOptions = {},
): ViewTransition | null {
  const root = document.documentElement;
  if (
    mode === 'none' ||
    typeof document.startViewTransition !== 'function' ||
    prefersReducedMotion()
  ) {
    update();
    return null;
  }
  const id = ++sequence;
  root.dataset.vt = mode;
  root.dataset.vtBusy = '1';
  root.style.setProperty('--vt-dir', String(opts.dir ?? 1));
  applyNames(mode);
  const transition = document.startViewTransition(() => {
    update();
    applyNames(mode);
  });
  // Safety net: if the browser never finishes (for example the popup was hidden), skip to the end state.
  const guard = setTimeout(
    () => {
      try {
        transition.skipTransition();
      } catch {
        // already finished
      }
    },
    Math.max(1500, tokenMs('--dur-reveal', 560) * 2.5),
  );
  const end = (): void => {
    clearTimeout(guard);
    if (id === sequence) {
      delete root.dataset.vt;
      delete root.dataset.vtBusy;
    }
  };
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  transition.finished.then(end, end);
  return transition;
}

/** Circle Reveal: the new theme is clipped to a circle that grows from the click point. */
export function circleReveal(x: number, y: number, update: () => void): ViewTransition | null {
  const transition = runTransition('theme', update);
  if (!transition) return null;
  const root = document.documentElement;
  const radius = Math.hypot(Math.max(x, root.clientWidth - x), Math.max(y, root.clientHeight - y));
  const duration = tokenMs('--dur-reveal', 560);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration,
          easing: getComputedStyle(root).getPropertyValue('--ease-out').trim() || 'ease-out',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    })
    .catch(() => {});
  return transition;
}
