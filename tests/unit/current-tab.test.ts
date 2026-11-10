import { expect, test } from 'bun:test';
import { createYoutubeSwitcher } from '../../src/background/platforms/youtube';
import { fakeChrome } from '../fakes/chrome';
import { loginAs, PASSWORD, startWorker } from '../fakes/harness';
import { fakeYouTube } from '../fakes/youtube';

function twoTabs() {
  const f = fakeYouTube([
    { id: 1, active: true, url: 'https://www.youtube.com/?authuser=0' },
    { id: 2, active: true, url: 'https://www.youtube.com/?authuser=2' },
  ]);
  const injected: number[] = [];
  const execute = f.deps.scripting.executeScript;
  f.deps.scripting.executeScript = (options) => {
    injected.push(options.target.tabId);
    f.state.data = { SESSION_INDEX: options.target.tabId === 2 ? '2' : '0' };
    return execute(options);
  };
  return { ...f, injected, youtube: createYoutubeSwitcher(f.deps) };
}

test('YouTube reads the requested tab, never the first active tab in another window', async () => {
  const f = twoTabs();
  expect(await f.youtube.readCurrent(2)).toEqual({ ok: true, value: { authuser: 2 } });
  expect(f.injected).toEqual([2]);
  expect(f.state.calls).not.toContain('query');
  expect(await f.youtube.readCurrent(1)).toEqual({ ok: true, value: { authuser: 0 } });
});

test('missing, closed and navigated tabs never fall back to another YouTube window', async () => {
  const f = twoTabs();
  for (const id of [undefined, 99, 2]) {
    if (id === 2) f.state.tabs.set(2, { id: 2, url: 'https://www.facebook.com/' });
    expect(await f.youtube.readCurrent(id)).toEqual({ ok: false, error: 'no_youtube_tab' });
  }
  expect(f.injected).toEqual([]);
  expect(f.state.calls).not.toContain('query');
});

test('a tab closing during the read is not found, while a live-tab scripting failure stays an API error', async () => {
  const closed = twoTabs();
  const get = closed.deps.tabs.get;
  closed.deps.tabs.get = async (id) => {
    const tab = await get(id);
    closed.state.tabs.delete(id);
    return tab;
  };
  expect(await closed.youtube.readCurrent(2)).toEqual({ ok: false, error: 'no_youtube_tab' });
  expect(closed.state.calls).not.toContain('query');
  const alive = twoTabs();
  alive.state.fail = 'script';
  expect(await alive.youtube.readCurrent(2)).toEqual({ ok: false, error: 'api_error' });
});

test('router probe, add and update use the supplied YouTube tab id', async () => {
  const f = twoTabs();
  const h = await startWorker(fakeChrome(), f.youtube);
  expect(await h.must({ type: 'account.probe', platform: 'youtube', tabId: 2 })).toMatchObject({
    tail: '3',
    accountId: null,
  });
  const added = await h.must<{ id: string; youtube: { authuser: number } }>({
    type: 'account.addCurrent',
    platform: 'youtube',
    label: 'Window B',
    tabId: 2,
  });
  expect(added.youtube).toEqual({ authuser: 2 });
  expect(await h.must({ type: 'account.probe', platform: 'youtube', tabId: 2 })).toMatchObject({
    accountId: added.id,
  });
  await h.must({ type: 'account.updateSession', accountId: added.id, tabId: 1 });
  expect(f.injected).toEqual([2, 2, 2, 1]);
  expect(await h.must({ type: 'account.probe', platform: 'youtube', tabId: 99 })).toEqual({
    tail: null,
    accountId: null,
  });
  expect(
    await h.send({
      type: 'account.addCurrent',
      platform: 'youtube',
      label: 'Closed',
      tabId: 99,
    }),
  ).toEqual({ ok: false, error: 'not_logged_in' });
});

test('tab ids accept nonnegative integers only', async () => {
  const h = await startWorker();
  for (const tabId of [-1, 1.5, '2', null, Infinity, NaN]) {
    expect(await h.send({ type: 'account.probe', platform: 'youtube', tabId })).toEqual({
      ok: false,
      error: 'bad_request',
    });
  }
});

test('contextual FB/IG reads reject a closed or navigated tab; ordinary cookies stay profile-wide', async () => {
  const h = await startWorker();
  await h.must({ type: 'vault.setup', password: PASSWORD });
  for (const platform of ['facebook', 'instagram'] as const) {
    await loginAs(h.chrome, platform, '1234567890');
    h.chrome.tabs.tabs.push({ id: 55, url: `https://www.${platform}.com/`, active: true });
    expect(await h.must({ type: 'account.probe', platform, tabId: 55 })).toMatchObject({
      tail: '7890',
    });
    h.chrome.tabs.tabs.splice(0);
    for (const tabId of [55, 99]) {
      expect(await h.must({ type: 'account.probe', platform, tabId })).toEqual({
        tail: null,
        accountId: null,
      });
      expect(await h.send({ type: 'account.addCurrent', platform, tabId, label: 'Gone' })).toEqual({
        ok: false,
        error: 'not_logged_in',
      });
    }
    h.chrome.tabs.tabs.push({ id: 55, url: 'https://www.youtube.com/' });
    expect(await h.must({ type: 'account.probe', platform, tabId: 55 })).toEqual({
      tail: null,
      accountId: null,
    });
    expect(
      await h.send({ type: 'account.addCurrent', platform, tabId: 55, label: 'Moved' }),
    ).toEqual({ ok: false, error: 'not_logged_in' });
    // No contextual promise: every tab shares these cookies in this browser profile.
    expect(await h.must({ type: 'account.probe', platform })).toMatchObject({ tail: '7890' });
    h.chrome.tabs.tabs.splice(0);
  }
});
