import { runInNewContext } from 'node:vm';
import type { BrowserTab, ScriptingApi, TabsApi, TabUpdatedListener } from '../../src/lib/ports';

/** In-memory page/navigation boundary; runs the serialized MAIN function without module closures. */
export function fakeYouTube(initial: BrowserTab[] = []) {
  const tabs = new Map(initial.map((tab) => [tab.id, { ...tab }]));
  const listeners = new Set<TabUpdatedListener>();
  const state = {
    tabs,
    listeners,
    calls: [] as string[],
    keys: [] as string[],
    data: { SESSION_INDEX: '2', DELEGATED_SESSION_ID: '12345', EMAIL: 'private' } as Record<
      string,
      unknown
    >,
    missingConfig: false,
    throwConfig: false,
    fail: '',
    loading: false,
    resultOverride: undefined as unknown,
    emptyResult: false,
    serialized: false,
    finish(id: number) {
      const tab = tabs.get(id);
      if (!tab) throw new Error('unknown tab');
      tab.status = 'complete';
      for (const listener of listeners) listener(id, { status: 'complete' }, tab);
    },
  };
  const guard = (op: string) => {
    state.calls.push(op);
    if (state.fail === op) throw new Error('browser operation failed');
  };
  const api: TabsApi = {
    async query() {
      guard('query');
      return [...tabs.values()];
    },
    async get(id) {
      guard('get');
      const tab = tabs.get(id);
      if (!tab) throw new Error('closed');
      return { ...tab };
    },
    async update(id, options) {
      guard('update');
      const tab = tabs.get(id);
      if (!tab) throw new Error('closed');
      Object.assign(tab, options, { status: state.loading ? 'loading' : 'complete' });
      return { ...tab };
    },
    async create(options) {
      guard('create');
      const tab = {
        id: 99,
        ...options,
        status: state.loading ? 'loading' : 'complete',
      };
      tabs.set(99, tab);
      return { ...tab };
    },
    async reload(id) {
      guard(`reload:${id}`);
    },
    onUpdated: {
      addListener(listener) {
        guard('listen');
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
    },
  };
  const scripting: ScriptingApi = {
    async executeScript(options) {
      guard('script');
      if (options.world !== 'MAIN' || options.target.tabId === undefined)
        throw new Error('invalid injection');
      if (state.emptyResult) return [];
      const ytcfg = {
        get(key: string) {
          state.keys.push(key);
          if (state.throwConfig) throw new Error('page failure');
          return state.data[key];
        },
      };
      const serialized: unknown = runInNewContext(
        `(${options.func.toString()})()`,
        state.missingConfig ? {} : { ytcfg },
      );
      let value: unknown = serialized;
      if (!state.serialized) {
        const original = Object.getOwnPropertyDescriptor(globalThis, 'ytcfg');
        try {
          if (state.missingConfig) Reflect.deleteProperty(globalThis, 'ytcfg');
          else Object.defineProperty(globalThis, 'ytcfg', { value: ytcfg, configurable: true });
          // Exercise the same callback in the instrumented test realm for coverage.
          state.keys.length = 0;
          value = options.func();
        } finally {
          if (original) Object.defineProperty(globalThis, 'ytcfg', original);
          else Reflect.deleteProperty(globalThis, 'ytcfg');
        }
      }
      return [{ frameId: 0, result: state.resultOverride ?? value }];
    },
  };
  return { state, deps: { tabs: api, scripting, loadTimeoutMs: 25 } };
}
