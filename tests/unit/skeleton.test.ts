import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrowserTab } from '../../src/lib/ports';
import { fakeLifecycle, fakeSessionStorage } from '../fakes/chrome';

// The real adapter wires listeners to the global `chrome` at import time; give it a minimal stand-in.
const onInstalled = mock();
const onStartup = mock();
const onMessage = mock();
const setAccessLevel = mock(async () => {});
const area = () => ({
  get: mock(async () => ({})),
  set: mock(async () => {}),
  remove: mock(async () => {}),
});
const local = area();
const session = { ...area(), setAccessLevel };
const cookies = {
  getAll: mock(async () => []),
  set: mock(async () => null),
  remove: mock(async () => null),
};
const tabListeners: unknown[] = [];
const tabs = {
  query: mock(async (): Promise<BrowserTab[]> => []),
  get: mock(async (): Promise<BrowserTab> => ({ active: true })),
  onUpdated: {
    addListener: mock((l: unknown) => tabListeners.push(l)),
    removeListener: mock((l: unknown) => tabListeners.splice(tabListeners.indexOf(l), 1)),
  },
  reload: mock(async () => {}),
  update: mock(async () => undefined),
  create: mock(async () => ({ active: true })),
};
const scripting = {
  executeScript: mock(async (): Promise<{ frameId: number; result?: unknown }[]> => []),
};
Object.assign(globalThis, {
  chrome: {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      onMessage: { addListener: onMessage },
      onInstalled: { addListener: onInstalled },
      onStartup: { addListener: onStartup },
    },
    storage: { local, session },
    cookies,
    tabs,
    scripting,
  },
});
const { hardenSessionStorage, start, workerDeps } = await import(
  '../../src/background/service-worker'
);
const adapter = await import('../../src/background/chrome-adapter');

test('hardenSessionStorage restricts storage.session to trusted contexts', async () => {
  const session = fakeSessionStorage();
  await hardenSessionStorage(session);
  expect(session.accessLevel).toBe('TRUSTED_CONTEXTS');
});

test('start hardens storage.session on install, update and browser startup', async () => {
  const session = fakeSessionStorage();
  const lifecycle = fakeLifecycle();
  start(lifecycle, session);
  expect(session.accessLevel).toBeNull();
  lifecycle.fire();
  await Promise.resolve();
  expect(session.accessLevel).toBe('TRUSTED_CONTEXTS');
});

test('start logs instead of throwing when Chrome rejects the call', async () => {
  const errors = mock();
  const original = console.error;
  console.error = errors;
  try {
    const lifecycle = fakeLifecycle();
    start(lifecycle, {
      ...fakeSessionStorage(),
      setAccessLevel: () => Promise.reject(new Error('nope')),
    });
    lifecycle.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveBeenCalledTimes(1);
  } finally {
    console.error = original;
  }
});

test('the chrome adapter passes calls straight through to chrome.*', async () => {
  // importing service-worker.ts ran start() with the real adapter
  expect(onInstalled).toHaveBeenCalledTimes(1);
  expect(onStartup).toHaveBeenCalledTimes(1);
  const handler = onInstalled.mock.calls[0]?.[0] as () => void;
  handler();
  await Promise.resolve();
  expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
});

test('popup html points at the module entry', () => {
  const html = readFileSync(new URL('../../src/popup/index.html', import.meta.url), 'utf8');
  expect(html).toContain('<script type="module" src="./main.ts">');
  // the theme boot script is classic and comes before the stylesheet, so first paint has the right colours
  const boot = html.indexOf('<script src="/theme-boot.js"></script>');
  expect(boot).toBeGreaterThan(-1);
  expect(boot).toBeLessThan(html.indexOf('rel="stylesheet"'));
});

test('every other adapter function is a straight pass-through', async () => {
  await adapter.localStorageApi.get('k');
  await adapter.localStorageApi.set({ k: 1 });
  await adapter.localStorageApi.remove('k');
  expect(local.get).toHaveBeenCalledWith('k');
  expect(local.set).toHaveBeenCalledWith({ k: 1 });
  expect(local.remove).toHaveBeenCalledWith('k');
  await adapter.sessionStorageApi.get(['a']);
  expect(session.get).toHaveBeenCalledWith(['a']);

  const details = { url: 'https://www.facebook.com/', name: 'xs' };
  await adapter.cookiesApi.getAll({ domain: 'facebook.com', partitionKey: {} });
  await adapter.cookiesApi.remove(details);
  await adapter.cookiesApi.set({
    ...details,
    value: 'v',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  });
  expect(cookies.getAll).toHaveBeenCalledWith({ domain: 'facebook.com', partitionKey: {} });
  expect(cookies.remove).toHaveBeenCalledWith(details);
  expect(cookies.set).toHaveBeenCalledTimes(1);

  await adapter.tabsApi.query({ url: ['*://*.facebook.com/*'] });
  await adapter.tabsApi.reload(3);
  await adapter.tabsApi.update(3, { url: 'https://www.youtube.com/', active: true });
  await adapter.tabsApi.create({ url: 'https://www.youtube.com/', active: false });
  expect(tabs.query).toHaveBeenCalledWith({ url: ['*://*.facebook.com/*'] });
  expect(tabs.reload).toHaveBeenCalledWith(3);
  expect(tabs.update).toHaveBeenCalledWith(3, { url: 'https://www.youtube.com/', active: true });
  expect(tabs.create).toHaveBeenCalledWith({ url: 'https://www.youtube.com/', active: false });

  const injection = { target: { tabId: 3 }, world: 'MAIN' as const, func: () => 1 };
  await adapter.scriptingApi.executeScript(injection);
  expect(scripting.executeScript).toHaveBeenCalledWith(injection);
});

test('the real YouTube switcher reads a tab through the tabs and scripting adapters', async () => {
  const deps = workerDeps();
  tabs.get.mockImplementationOnce(async () => ({ id: 6, url: 'https://www.youtube.com/' }));
  tabs.get.mockImplementationOnce(async () => ({ id: 6, url: 'https://www.youtube.com/' }));
  scripting.executeScript.mockImplementationOnce(async () => [
    { frameId: 0, result: { authuser: 1, pageid: '42' } },
  ]);
  expect(await deps.youtube.readCurrent(6)).toEqual({
    ok: true,
    value: { authuser: 1, pageid: '42' },
  });
  expect(scripting.executeScript).toHaveBeenLastCalledWith(
    expect.objectContaining({ target: { tabId: 6 }, world: 'MAIN' }),
  );
});

test('tabs.onUpdated relays events and unsubscribes', async () => {
  const seen: number[] = [];
  const listener = (tabId: number) => {
    seen.push(tabId);
  };
  adapter.tabsApi.onUpdated.addListener(listener);
  (tabListeners[0] as (id: number, info: object, tab: object) => void)(
    4,
    { status: 'complete' },
    {},
  );
  adapter.tabsApi.onUpdated.removeListener(listener);
  expect(seen).toEqual([4]);
  expect(tabListeners).toEqual([]);
  await adapter.tabsApi.get(4);
  expect(tabs.get).toHaveBeenCalledWith(4);
});

test('runtime.onMessage answers with what the handler resolves to and keeps the channel open', async () => {
  // importing service-worker.ts registered the router
  expect(onMessage).toHaveBeenCalledTimes(1);
  const listener = onMessage.mock.calls[0]?.[0] as (
    m: unknown,
    s: object,
    send: (r: unknown) => void,
  ) => boolean;
  const answer = new Promise((resolve) => {
    expect(listener({ type: 'state.get' }, { id: 'someone-else' }, resolve)).toBe(true);
  });
  expect(await answer).toEqual({ ok: false, error: 'forbidden' });
  expect(adapter.runtimeApi.id).toBe('abcdefghijklmnopabcdefghijklmnop');
});

test('the worker wires real adapters, a clock, UUIDs and the YouTube switcher', async () => {
  const deps = workerDeps();
  expect(deps.cookies).toBe(adapter.cookiesApi);
  expect(Math.abs(deps.now() - Date.now())).toBeLessThan(1000);
  expect(deps.newId()).toMatch(/^[0-9a-f-]{36}$/);
  expect(deps.newId()).not.toBe(deps.newId());
  // The stand-in chrome has no tabs: the real YouTube code answers through the tabs adapter.
  expect(await deps.youtube.readCurrent(6)).toEqual({ ok: false, error: 'no_youtube_tab' });
  expect(tabs.get).toHaveBeenCalledWith(6);
  // create() gives back a tab without an id here, so there is nothing to switch.
  expect(await deps.youtube.switchTo({ authuser: 0 })).toEqual({ ok: false, error: 'invalid_tab' });
});
