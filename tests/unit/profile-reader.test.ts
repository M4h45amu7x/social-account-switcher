import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { YouTubeSession } from '../../src/background/platforms/types';
import { readProfile as readCheckedProfile, readPageProfile } from '../../src/background/profile';
import type { ScriptingApi, TabsApi } from '../../src/lib/ports';
import type { Platform } from '../../src/lib/store';
import { fakeChrome } from '../fakes/chrome';
import { PNG } from '../fixtures/profile';

const readProfile = (
  deps: { tabs: TabsApi; scripting: ScriptingApi },
  platform: Platform,
  identity: string | YouTubeSession,
  tabId?: number,
) =>
  readCheckedProfile({ ...deps, currentIdentity: async () => identity }, platform, identity, tabId);

const imagesDescriptor = Object.getOwnPropertyDescriptor(document, 'images');
beforeEach(() => {
  // happy-dom does not implement document.images; Chrome exposes the live image collection.
  Object.defineProperty(document, 'images', {
    configurable: true,
    get: () => document.querySelectorAll('img'),
  });
});
const clear = () => {
  document.body.innerHTML = '';
  for (const key of ['_sharedData', 'ytcfg']) Reflect.deleteProperty(globalThis, key);
  if (imagesDescriptor) Object.defineProperty(document, 'images', imagesDescriptor);
  else Reflect.deleteProperty(document, 'images');
};
afterEach(clear);
// happy-dom URL is set via the registered Window location without navigation.
function url(host: string) {
  location.href = `https://${host}/`;
}
const fb = (id = '1001') =>
  `<script type="application/json" data-sjs>${JSON.stringify({ define: [['CurrentUserInitialData', [], { USER_ID: id, NAME: 'Alice', USERNAME: 'alice' }]] })}</script>`;
test('Facebook reads CurrentUserInitialData, not a visited profile/feed user', () => {
  url('www.facebook.com');
  document.body.innerHTML = fb();
  expect(readPageProfile()).toMatchObject({
    identity: '1001',
    profile: { displayName: 'Alice', handle: 'alice' },
  });
});
test('Instagram reads the signed-in viewer JSON', () => {
  url('www.instagram.com');
  document.body.innerHTML =
    '<script type="application/json">{"config":{"viewer":{"id":"2001","full_name":"Insta Name","username":"insta"}}}</script>';
  expect(readPageProfile()).toMatchObject({
    identity: '2001',
    profile: { displayName: 'Insta Name', handle: 'insta' },
  });
});
test('YouTube binds existing config and already rendered menu to sign-in coordinates', () => {
  url('www.youtube.com');
  Object.assign(globalThis, {
    ytcfg: { get: (key: string) => ({ SESSION_INDEX: '2', DELEGATED_SESSION_ID: '333' })[key] },
  });
  document.body.innerHTML =
    '<ytd-active-account-header-renderer data-session-index="2" data-delegated-session-id="333"><div id="account-name">YT Name</div><div id="channel-handle">@yt</div><div id="email">yt@example.test</div></ytd-active-account-header-renderer>';
  expect(readPageProfile()).toMatchObject({
    identity: { authuser: 2, pageid: '333' },
    profile: { displayName: 'YT Name', handle: '@yt', email: 'yt@example.test' },
  });
});
test('DOM fallback needs its own matching identity', () => {
  url('www.facebook.com');
  document.body.innerHTML =
    '<nav><a href="/profile.php?id=1001" title="DOM Alice">DOM Alice</a></nav>';
  expect(readPageProfile()).toMatchObject({
    identity: '1001',
    profile: { displayName: 'DOM Alice' },
  });
  url('www.instagram.com');
  document.body.innerHTML =
    '<nav><a data-user-id="2001" href="/insta/" title="DOM Insta">DOM Insta</a></nav>';
  expect(readPageProfile()).toMatchObject({
    identity: '2001',
    profile: { displayName: 'DOM Insta', handle: 'insta' },
  });
});
test('worker uses only the explicit tab and rejects mismatched IDs or a changed URL', async () => {
  const c = fakeChrome({
    tabs: [
      { url: 'https://www.facebook.com/', active: true },
      { url: 'https://www.facebook.com/' },
    ],
  });
  const tab = (await c.tabs.query({ active: true }))[0]?.id as number;
  c.scripting.pageResults.set(tab, { identity: '1001', profile: { displayName: 'Alice' } });
  expect(await readProfile(c, 'facebook', '1001', tab)).toEqual({ displayName: 'Alice' });
  expect(await readProfile(c, 'facebook', '9999', tab)).toBeUndefined();
  expect(await readProfile(c, 'facebook', '1001')).toBeUndefined();
  expect(await readProfile(c, 'instagram', '1001', tab)).toBeUndefined();
  const executeScript = c.scripting.executeScript;
  c.scripting.executeScript = async (options) => {
    const result = await executeScript(options);
    await c.tabs.update(tab, { url: 'https://www.facebook.com/elsewhere', active: true });
    return result;
  };
  expect(await readProfile(c, 'facebook', '1001', tab)).toBeUndefined();
});

test('malformed, absent, logged-out and lookalike pages produce no profile', () => {
  for (const host of [
    'www.facebook.com',
    'www.instagram.com',
    'www.youtube.com',
    'www.tiktok.com',
    'facebook.com.evil.test',
    'evil-tiktok.com',
  ]) {
    url(host);
    document.body.innerHTML =
      '<script type="application/json" data-sjs>bad CurrentUserInitialData</script><script id="__SAM_TIKTOK_VIEWER__">{"state":"signed_out"}</script>';
    expect(readPageProfile()).toBeNull();
  }
  url('www.youtube.com');
  for (const config of [
    { SESSION_INDEX: -1 },
    { SESSION_INDEX: 0, DELEGATED_SESSION_ID: {} },
    { SESSION_INDEX: 'bad' },
  ]) {
    Object.assign(globalThis, {
      ytcfg: { get: (key: string) => (config as Record<string, unknown>)[key] },
    });
    expect(readPageProfile()).toBeNull();
  }
  Object.assign(globalThis, {
    ytcfg: {
      get: () => {
        throw new Error('page error');
      },
    },
  });
  expect(readPageProfile()).toBeNull();
});
test('Instagram global viewer outranks DOM and remote avatar never crosses the boundary', () => {
  url('www.instagram.com');
  Object.assign(globalThis, {
    _sharedData: {
      config: {
        viewer: {
          id: '2001',
          full_name: 'Viewer',
          username: 'mine',
          profile_pic_url: 'https://cdn.test/not-loaded.png',
        },
      },
    },
  });
  document.body.innerHTML =
    '<nav><a data-user-id="9999" href="/stranger/" title="Stranger">Stranger</a></nav>';
  expect(readPageProfile()).toEqual({
    identity: '2001',
    profile: { displayName: 'Viewer', handle: 'mine' },
  });
});
test('profile injection is frame-zero only, no fallback on closed tabs/API failures, YouTube coordinates must match', async () => {
  const c = fakeChrome({ tabs: [{ url: 'https://www.youtube.com/', active: true }] });
  c.scripting.pageResults.set(1, {
    identity: { authuser: 1, pageid: '33' },
    profile: { displayName: 'YT' },
  });
  expect(await readProfile(c, 'youtube', { authuser: 1, pageid: '33' }, 1)).toEqual({
    displayName: 'YT',
  });
  expect(await readProfile(c, 'youtube', { authuser: 1 }, 1)).toBeUndefined();
  expect(await readProfile(c, 'youtube', { authuser: 2, pageid: '33' }, 1)).toBeUndefined();
  expect(await readProfile(c, 'youtube', { authuser: 1 }, 99)).toBeUndefined();
  c.scripting.executeScript = async () => [
    { frameId: 1, result: { identity: { authuser: 1 }, profile: { displayName: 'Child' } } },
  ];
  expect(await readProfile(c, 'youtube', { authuser: 1 }, 1)).toBeUndefined();
  c.scripting.executeScript = async () => {
    throw new Error('denied');
  };
  expect(await readProfile(c, 'youtube', { authuser: 1 }, 1)).toBeUndefined();
});

test('loaded image pixels scale to 64px and canvas errors never discard the textual profile', () => {
  url('www.facebook.com');
  document.body.innerHTML =
    '<nav><a href="/profile.php?id=1001" title="Alice"><img src="https://www.facebook.com/avatar.png"></a></nav>';
  const img = document.querySelector('img');
  if (!img) throw new Error('missing image fixture');
  Object.defineProperties(img, {
    complete: { configurable: true, value: true },
    naturalWidth: { value: 128 },
    naturalHeight: { value: 96 },
  });
  const canvas = document.createElement('canvas');
  const drawImage = spyOn(canvas, 'getContext').mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
  const data = spyOn(canvas, 'toDataURL').mockReturnValue(PNG);
  const createElement = document.createElement.bind(document);
  const create = spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas' ? canvas : createElement(tag)) as typeof document.createElement);
  try {
    expect(readPageProfile()).toMatchObject({
      identity: '1001',
      profile: { displayName: 'Alice', avatar: PNG },
    });
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(48);
    data.mockImplementation(() => {
      throw new DOMException('Tainted', 'SecurityError');
    });
    expect(readPageProfile()).toEqual({ identity: '1001', profile: { displayName: 'Alice' } });
    drawImage.mockReturnValue(null);
    expect(readPageProfile()).toEqual({ identity: '1001', profile: { displayName: 'Alice' } });
    Object.defineProperty(img, 'complete', { value: false });
    expect(readPageProfile()).toEqual({ identity: '1001', profile: { displayName: 'Alice' } });
  } finally {
    create.mockRestore();
    data.mockRestore();
    drawImage.mockRestore();
  }
});

test('page identity changes during property extraction discard the profile', () => {
  url('www.youtube.com');
  let index = '1';
  Object.assign(globalThis, {
    ytcfg: {
      get: (key: string) => {
        if (key === 'SESSION_INDEX') return index;
        if (key === 'ACCOUNT_NAME') {
          index = '2';
          return 'Bob';
        }
        return undefined;
      },
    },
  });
  expect(readPageProfile()).toBeNull();
  url('www.instagram.com');
  const viewer = {
    id: '1001',
    get full_name() {
      this.id = '2002';
      return 'Bob';
    },
  };
  Object.assign(globalThis, { _sharedData: { config: { viewer } } });
  expect(readPageProfile()).toBeNull();
});

test('YouTube DOM header needs its own matching account and brand coordinates', () => {
  url('www.youtube.com');
  Object.assign(globalThis, {
    ytcfg: { get: (key: string) => ({ SESSION_INDEX: '2', DELEGATED_SESSION_ID: '333' })[key] },
  });
  for (const attributes of [
    '',
    'data-session-index="1" data-delegated-session-id="333"',
    'data-session-index="2" data-delegated-session-id="444"',
    'data-session-index="2"',
  ]) {
    document.body.innerHTML = `<ytd-active-account-header-renderer ${attributes}><div id="account-name">Stale Alice</div><div id="email">alice@example.test</div><img src="${PNG}"></ytd-active-account-header-renderer>`;
    expect(readPageProfile()).toEqual({ identity: { authuser: 2, pageid: '333' }, profile: {} });
  }
});

test('completed same-URL reload during extraction discards profile and removes its listener', async () => {
  const c = fakeChrome({ tabs: [{ url: 'https://www.facebook.com/', active: true }] });
  const add = spyOn(c.tabs.onUpdated, 'addListener');
  const remove = spyOn(c.tabs.onUpdated, 'removeListener');
  c.scripting.executeScript = async () => {
    await c.tabs.reload(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [{ frameId: 0, result: { identity: '1001', profile: { displayName: 'Alice' } } }];
  };
  expect(await readProfile(c, 'facebook', '1001', 1)).toBeUndefined();
  expect(add).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(add.mock.calls[0]?.[0]);
});

test('all optional read boundaries time out, clean up, and ignore late results', async () => {
  for (const boundary of ['get', 'script', 'identity'] as const) {
    const c = fakeChrome({ tabs: [{ url: 'https://www.facebook.com/', active: true }] });
    c.scripting.pageResults.set(1, { identity: '1001', profile: { displayName: 'Alice' } });
    const remove = spyOn(c.tabs.onUpdated, 'removeListener');
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = c.tabs.get;
    const script = c.scripting.executeScript;
    if (boundary === 'get')
      c.tabs.get = async (id) => {
        await held;
        return get(id);
      };
    if (boundary === 'script')
      c.scripting.executeScript = async (options) => {
        await held;
        return script(options);
      };
    const pending = readCheckedProfile(
      {
        ...c,
        timeoutMs: 10,
        currentIdentity: async () => {
          if (boundary === 'identity') await held;
          return '1001';
        },
      },
      'facebook',
      '1001',
      1,
    );
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise((resolve) => {
          watchdog = setTimeout(() => resolve('still blocked'), 80);
        }),
      ]);
      expect(result).toBeUndefined();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      release();
      await pending;
    }
    expect(await pending).toBeUndefined();
  }
});
