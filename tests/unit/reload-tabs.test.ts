import { expect, test } from 'bun:test';
import { createTikTokPlatform, TIKTOK_EXPERIMENT } from '../../src/background/platforms/tiktok';
import { reloadTabs } from '../../src/background/reload-tabs';
import { fakeChrome } from '../fakes/chrome';

function harness() {
  const c = fakeChrome({
    tabs: [
      { url: 'https://www.tiktok.com/', active: true },
      { url: 'https://www.tiktok.com/slow', active: false },
    ],
  });
  const p = createTikTokPlatform(c, { ...TIKTOK_EXPERIMENT, enabled: true });
  return { c, p };
}

test('verified reload waits for the last tab before returning the active tab', async () => {
  const { c, p } = harness();
  let release = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  c.tabs.onLoad = async (tab) => {
    if (tab.id === 2) await slow;
  };
  const { firstLoaded, reloaded } = await reloadTabs(
    { tabs: c.tabs, loadTimeoutMs: 1000, requireComplete: true },
    p,
  );
  let settled = false;
  void firstLoaded.then(() => {
    settled = true;
  });
  try {
    await Bun.sleep(10);
    expect(reloaded).toBe(2);
    expect(settled).toBe(false);
  } finally {
    release();
  }
  expect((await firstLoaded)?.id).toBe(1);
});

for (const failure of ['rejected', 'closed', 'timeout'] as const) {
  test(`verified reload reports unknown completion if a non-active tab is ${failure}`, async () => {
    const { c, p } = harness();
    const reload = c.tabs.reload.bind(c.tabs);
    c.tabs.reload = async (id) => {
      if (id === 2) {
        if (failure === 'rejected') throw new Error('refused');
        if (failure === 'closed') c.tabs.tabs.splice(1, 1);
        return;
      }
      await reload(id);
    };
    const { firstLoaded } = await reloadTabs(
      { tabs: c.tabs, loadTimeoutMs: 15, requireComplete: true },
      p,
    );
    expect(await firstLoaded).toBeNull();
  });
}

test('legacy reload still returns after the active tab; unverified slow tabs do not delay it', async () => {
  const { c, p } = harness();
  const reload = c.tabs.reload.bind(c.tabs);
  c.tabs.reload = async (id) => {
    if (id === 1) await reload(id);
  };
  const { firstLoaded } = await reloadTabs({ tabs: c.tabs, loadTimeoutMs: 100 }, p);
  expect((await firstLoaded)?.id).toBe(1);
});
