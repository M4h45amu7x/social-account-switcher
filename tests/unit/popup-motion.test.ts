import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  applyNames,
  circleReveal,
  prefersReducedMotion,
  runTransition,
  tokenMs,
} from '../../src/popup/motion';

interface FakeTransition {
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  finished: Promise<void>;
  skipTransition: () => void;
  finish: () => void;
  skipped: number;
}

let created: FakeTransition[] = [];
let callbacks: (() => void)[] = [];
const doc = document as unknown as { startViewTransition?: unknown };

function installApi(): void {
  doc.startViewTransition = (cb: () => void): FakeTransition => {
    callbacks.push(cb);
    let finish: () => void = () => {};
    const finished = new Promise<void>((r) => {
      finish = r;
    });
    const t: FakeTransition = {
      ready: Promise.resolve(),
      updateCallbackDone: Promise.resolve(),
      finished,
      skipTransition: () => {
        t.skipped++;
      },
      finish,
      skipped: 0,
    };
    created.push(t);
    queueMicrotask(cb);
    return t;
  };
}
const setReduced = (on: boolean): void => {
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: on && q.includes('prefers-reduced-motion'),
  });
};
const original = globalThis.matchMedia;

beforeEach(() => {
  created = [];
  callbacks = [];
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-vt');
  document.documentElement.removeAttribute('data-vt-busy');
  setReduced(false);
  installApi();
});
afterEach(() => {
  doc.startViewTransition = undefined;
  (globalThis as unknown as { matchMedia: unknown }).matchMedia = original;
});

describe('runTransition', () => {
  test('mode none just runs the update', () => {
    let ran = 0;
    expect(runTransition('none', () => ran++)).toBeNull();
    expect(ran).toBe(1);
    expect(created.length).toBe(0);
  });

  test('without the View Transitions API the DOM still updates', () => {
    doc.startViewTransition = undefined;
    let ran = 0;
    expect(runTransition('tab', () => ran++)).toBeNull();
    expect(ran).toBe(1);
  });

  test('prefers-reduced-motion: reduce never starts a transition', () => {
    setReduced(true);
    expect(prefersReducedMotion()).toBe(true);
    let ran = 0;
    expect(runTransition('page', () => ran++)).toBeNull();
    expect(ran).toBe(1);
    expect(created.length).toBe(0);
  });

  test('sets data-vt, the direction and the names, runs update in the callback, then cleans up', async () => {
    document.body.innerHTML =
      '<button class="tab"><span class="pill"></span></button><section data-panel></section>';
    const root = document.documentElement;
    let ran = 0;
    const t = runTransition('tab', () => ran++, { dir: -1 });
    expect(t).not.toBeNull();
    expect(root.dataset.vt).toBe('tab');
    expect(root.dataset.vtBusy).toBe('1');
    expect(root.style.getPropertyValue('--vt-dir')).toBe('-1');
    expect(document.querySelector<HTMLElement>('.pill')?.style.viewTransitionName).toBe('pill');
    expect(document.querySelector<HTMLElement>('[data-panel]')?.style.viewTransitionName).toBe(
      'panel',
    );
    await Promise.resolve();
    expect(ran).toBe(1);
    created[0]?.finish();
    await created[0]?.finished;
    await Promise.resolve();
    expect(root.dataset.vt).toBeUndefined();
    expect(root.dataset.vtBusy).toBeUndefined();
  });

  test('names are applied again after the update so elements of the new DOM take part', async () => {
    document.body.innerHTML = '<section id="host"></section>';
    runTransition('list', () => {
      const host = document.getElementById('host');
      if (host) host.innerHTML = '<ul><li class="row" data-id="a"></li></ul>';
    });
    await Promise.resolve();
    const row = document.querySelector<HTMLElement>('.row');
    expect(row?.style.viewTransitionName).toBe('row-a');
    expect(row?.style.viewTransitionClass).toBe('row');
  });

  test('a finished older transition does not clear the flag of a newer one', async () => {
    runTransition('list', () => {});
    runTransition('status', () => {});
    created[0]?.finish();
    await created[0]?.finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.vt).toBe('status');
    created[1]?.finish();
    await created[1]?.finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  test('the watchdog skips a transition that never finishes', () => {
    const calls: { fn: () => void; ms: number }[] = [];
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms: number,
    ) => {
      calls.push({ fn, ms });
      return 1;
    }) as unknown as typeof setTimeout);
    try {
      runTransition('expand', () => {});
    } finally {
      spy.mockRestore();
    }
    const guard = calls.find((c) => c.ms >= 1500);
    expect(guard).toBeDefined();
    guard?.fn();
    expect(created[0]?.skipped).toBe(1);
  });

  test('skipTransition throwing after the transition ended is ignored', () => {
    const calls: (() => void)[] = [];
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      calls.push(fn);
      return 1;
    }) as unknown as typeof setTimeout);
    try {
      const t = runTransition('toast', () => {}) as unknown as FakeTransition;
      t.skipTransition = () => {
        throw new Error('InvalidStateError');
      };
    } finally {
      spy.mockRestore();
    }
    expect(() => calls[0]?.()).not.toThrow();
  });
});

describe('a skipped transition', () => {
  const rejecting = (): void => {
    doc.startViewTransition = (cb: () => void) => {
      queueMicrotask(cb);
      const fail = Promise.reject(new DOMException('Skipped', 'AbortError'));
      fail.catch(() => {});
      return {
        ready: fail,
        updateCallbackDone: fail,
        finished: Promise.resolve(),
        skipTransition() {},
      };
    };
  };

  test('rejected ready/updateCallbackDone promises are swallowed and the busy flag clears', async () => {
    rejecting();
    let ran = 0;
    runTransition('list', () => ran++);
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(1);
    expect(document.documentElement.dataset.vtBusy).toBeUndefined();
  });

  test('circleReveal does not throw when the transition is skipped before it is ready', async () => {
    rejecting();
    const t = circleReveal(5, 5, () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(t).not.toBeNull();
  });
});

describe('applyNames', () => {
  test('every named element gets its own stable name in the mode that uses it', () => {
    document.body.innerHTML = `<li class="row" data-id="a"></li><span class="slot" data-id="a"></span>
      <button class="tab"><span class="pill"></span></button><section data-panel></section>
      <div data-card="theme"></div><button data-sbtn></button><div class="toast"></div>`;
    const names = (mode: Parameters<typeof applyNames>[0]): Record<string, string> => {
      applyNames(mode);
      const out: Record<string, string> = {};
      for (const sel of [
        '.row',
        '.slot',
        '.pill',
        '[data-panel]',
        '[data-card]',
        '[data-sbtn]',
        '.toast',
      ]) {
        out[sel] = document.querySelector<HTMLElement>(sel)?.style.viewTransitionName ?? '';
      }
      return out;
    };
    expect(names('list')).toMatchObject({
      '.row': 'row-a',
      '.slot': 'slot-a',
      '.pill': '',
      '.toast': 'toast',
    });
    expect(names('tab')).toMatchObject({ '.pill': 'pill', '[data-panel]': 'panel', '.row': '' });
    expect(names('page')).toMatchObject({ '[data-panel]': 'panel', '.pill': '' });
    expect(names('expand')).toMatchObject({ '[data-card]': 'card-theme', '.row': 'row-a' });
    expect(names('status')).toMatchObject({ '[data-sbtn]': 'sbtn', '.slot': 'slot-a' });
    expect(names('toast')).toMatchObject({ '.toast': 'toast', '.row': '' });
  });

  test('toasts are named in every mode; rows only in list/status/expand', () => {
    document.body.innerHTML = '<div class="toast"></div><li class="row" data-id="x"></li>';
    applyNames('tab');
    expect(document.querySelector<HTMLElement>('.toast')?.style.viewTransitionName).toBe('toast');
    expect(document.querySelector<HTMLElement>('.row')?.style.viewTransitionName).toBe('');
    applyNames('status');
    expect(document.querySelector<HTMLElement>('.row')?.style.viewTransitionName).toBe('row-x');
  });

  test('swapped status buttons get one shared name', () => {
    document.body.innerHTML = '<button data-sbtn></button><div data-card="wipe"></div>';
    applyNames('status');
    expect(document.querySelector<HTMLElement>('[data-sbtn]')?.style.viewTransitionName).toBe(
      'sbtn',
    );
    expect(document.querySelector<HTMLElement>('[data-card]')?.style.viewTransitionName).toBe('');
    applyNames('expand');
    expect(document.querySelector<HTMLElement>('[data-card]')?.style.viewTransitionName).toBe(
      'card-wipe',
    );
  });
});

describe('tokenMs', () => {
  const stub = (value: string) =>
    spyOn(globalThis, 'getComputedStyle').mockImplementation((() => ({
      transitionDuration: value,
      getPropertyValue: () => '',
    })) as unknown as typeof getComputedStyle);

  test('reads ms and s values and cleans up its probe', () => {
    let spy = stub('240ms');
    expect(tokenMs('--dur-base', 1)).toBe(240);
    spy.mockRestore();
    spy = stub('0.42s');
    expect(tokenMs('--dur-slow', 1)).toBeCloseTo(420);
    spy.mockRestore();
    expect(document.body.querySelector('i')).toBeNull();
  });

  test('falls back when the token cannot be resolved', () => {
    const spy = stub('');
    expect(tokenMs('--nope', 560)).toBe(560);
    spy.mockRestore();
  });
});

describe('circleReveal', () => {
  test('animates the new root from a circle at the click point to one covering the far corner', async () => {
    const root = document.documentElement;
    Object.defineProperty(root, 'clientWidth', { value: 360, configurable: true });
    Object.defineProperty(root, 'clientHeight', { value: 520, configurable: true });
    const animations: {
      keyframes: { clipPath: string[] };
      options: { pseudoElement: string; duration: number };
    }[] = [];
    (root as unknown as { animate: unknown }).animate = (keyframes: never, options: never) => {
      animations.push({ keyframes, options });
    };
    let ran = 0;
    const t = circleReveal(100, 50, () => ran++);
    expect(t).not.toBeNull();
    expect(root.dataset.vt).toBe('theme');
    await t?.ready;
    await Promise.resolve();
    expect(ran).toBe(1);
    expect(animations.length).toBe(1);
    const a = animations[0];
    expect(a?.options.pseudoElement).toBe('::view-transition-new(root)');
    expect(a?.keyframes.clipPath[0]).toBe('circle(0px at 100px 50px)');
    const far = Math.hypot(260, 470);
    expect(a?.keyframes.clipPath[1]).toBe(`circle(${far}px at 100px 50px)`);
  });

  test('without the API the theme still switches', () => {
    doc.startViewTransition = undefined;
    let ran = 0;
    expect(circleReveal(1, 1, () => ran++)).toBeNull();
    expect(ran).toBe(1);
  });
});
