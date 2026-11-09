import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fakeLifecycle, fakeSessionStorage } from '../fakes/chrome';

// The real adapter wires listeners to the global `chrome` at import time; give it a minimal stand-in.
const onInstalled = mock();
const onStartup = mock();
const setAccessLevel = mock(async () => {});
Object.assign(globalThis, {
  chrome: {
    runtime: {
      onInstalled: { addListener: onInstalled },
      onStartup: { addListener: onStartup },
    },
    storage: { session: { setAccessLevel } },
  },
});
const { hardenSessionStorage, start } = await import('../../src/background/service-worker');
const { renderPopup } = await import('../../src/popup/view');

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
    start(lifecycle, { setAccessLevel: () => Promise.reject(new Error('nope')) });
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

test('popup renders every string through the translator', () => {
  const root = document.createElement('main');
  const seen: string[] = [];
  renderPopup(root, { version: '1.2.3' }, (key, subs) => {
    seen.push(key);
    return `[${key}${subs ? `:${subs.join(',')}` : ''}]`;
  });
  expect(root.querySelector('h1')?.textContent).toBe('[popupTitle]');
  expect(root.querySelector('.foot')?.textContent).toBe('[popupFooter:1.2.3]');
  expect(seen).toEqual(['popupTitle', 'popupComingSoon', 'popupFooter']);
});

test('popup html points at the module entry', () => {
  const html = readFileSync(new URL('../../src/popup/index.html', import.meta.url), 'utf8');
  expect(html).toContain('<script type="module" src="./main.ts">');
});
