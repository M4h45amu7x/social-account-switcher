import { expect, test } from 'bun:test';
import { readSession, switchAccount } from '../../src/background/platforms/youtube';
import { fakeYouTube } from '../fakes/youtube';

test('B4 reads and switches through injected ports with zero extension network requests', async () => {
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  let requests = 0;
  const deny = () => {
    requests++;
    throw new Error('Network access forbidden');
  };
  try {
    for (const name of names)
      Object.defineProperty(globalThis, name, { value: deny, configurable: true });
    const { deps } = fakeYouTube([
      { id: 1, active: true, url: 'https://youtube.com/watch?v=one' },
      { id: 2, url: 'https://youtube.com/' },
    ]);
    expect(await readSession(deps, 1)).toEqual({
      ok: true,
      value: { authuser: 2, pageid: '12345' },
    });
    expect(await switchAccount(deps, { authuser: 2, pageid: '12345' })).toEqual({
      ok: true,
      value: { tabId: 1, reloadedTabs: 1 },
    });
    expect(requests).toBe(0);
  } finally {
    for (const [index, name] of names.entries()) {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
