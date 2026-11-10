import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFixtureViewer } from '../../src/background/platforms/tiktok';
import { readPageProfile, readProfile } from '../../src/background/profile';
import { fakeChrome } from '../fakes/chrome';
import { PNG } from '../fixtures/profile';

const imagesDescriptor = Object.getOwnPropertyDescriptor(document, 'images');
beforeEach(() => {
  Object.defineProperty(document, 'images', {
    configurable: true,
    get: () => document.querySelectorAll('img'),
  });
});
const uid = '7100000000000000001';
const page = (user: unknown, extra = {}) => {
  location.href = 'https://www.tiktok.com/';
  document.body.innerHTML = '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"></script>';
  document.querySelector('script')!.textContent = JSON.stringify({
    __DEFAULT_SCOPE__: {
      'webapp.app-context': { user, ...extra },
      'webapp.video-detail': {
        author: { uid: '999', nickname: 'Wrong author', uniqueId: 'author', avatar: PNG },
      },
      'webapp.user-detail': { userInfo: { user: { uid: '888', nickname: 'Visited profile' } } },
    },
  });
};
afterEach(() => {
  document.body.innerHTML = '';
  if (imagesDescriptor) Object.defineProperty(document, 'images', imagesDescriptor);
  else Reflect.deleteProperty(document, 'images');
});

test('TikTok profile uses only the same app-context user as T3; never author, visited profile or T1', () => {
  page({
    uid,
    uniqueId: 'alice',
    nickname: 'Alice Profile',
    avatar: PNG,
    email: 'ignored@test.test',
  });
  document.body.innerHTML +=
    '<script id="__SAM_TIKTOK_VIEWER__">{"state":"signed_in","viewerId":"999","displayName":"Wrong legacy"}</script>';
  const before = document.body.innerHTML;
  const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  try {
    expect(readFixtureViewer()).toEqual({ state: 'signed_in', viewerId: uid });
    expect(readPageProfile()).toEqual({
      identity: uid,
      profile: { displayName: 'Alice Profile', handle: 'alice', avatar: PNG },
    });
    expect(document.body.innerHTML).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
  page({ uid, uniqueId: 'alice', nickname: [], avatar: {} });
  document.body.innerHTML +=
    '<a data-e2e="profile-icon" data-user-id="7100000000000000001" title="Unconfirmed DOM name">Author</a>';
  expect(readPageProfile()).toEqual({ identity: uid, profile: { handle: 'alice' } });
  page({ uid, uniqueId: 'alice', avatar: 'https://cdn.test/unloaded.png' });
  expect(readPageProfile()).toEqual({ identity: uid, profile: { handle: 'alice' } });
});

test('TikTok profile rejects all non-viewer states accepted as unknown/logout/checkpoint by T3', () => {
  for (const user of [
    null,
    [],
    {},
    { uid: 123, uniqueId: 'alice' },
    { uid: '01', uniqueId: 'alice' },
    { uid: '0', uniqueId: 'alice' },
    { uid: '1'.repeat(33), uniqueId: 'alice' },
    { uid, uniqueId: '<bad>' },
    { uid, uniqueId: '' },
  ]) {
    page(user);
    expect(readFixtureViewer()).toEqual({ state: 'unknown' });
    expect(readPageProfile()).toBeNull();
  }
  for (const isLogin of [false, 0, 'true']) {
    page({ uid, uniqueId: 'alice' }, { isLogin });
    expect(readPageProfile()).toBeNull();
  }
  for (const marker of [
    '<div id="captcha_container"></div>',
    '<div id="verifyEle"></div>',
    '<div data-e2e="captcha"></div>',
  ]) {
    page({ uid, uniqueId: 'alice' });
    document.body.innerHTML += marker;
    expect(readPageProfile()).toBeNull();
  }
  for (const text of [
    '{',
    '{}',
    JSON.stringify({ __DEFAULT_SCOPE__: [] }),
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    page(null);
    document.querySelector('script')!.textContent = text;
    expect(readPageProfile()).toBeNull();
  }
  document.body.innerHTML =
    '<script id="__SAM_TIKTOK_VIEWER__">{"state":"signed_in","viewerId":"123","displayName":"Legacy"}</script>';
  expect(readPageProfile()).toBeNull();
});

test('TikTok profile shares the 1 MiB T3 bound, accepts optional true discriminator and all strict hosts', () => {
  for (const host of ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']) {
    page({ uid, uniqueId: 'alice', nickname: 'Alice Profile' }, { isLogin: true });
    location.href = `https://${host}/`;
    document.querySelector('script')!.textContent += ' '.repeat(300000);
    expect(readPageProfile()).toMatchObject({
      identity: uid,
      profile: { displayName: 'Alice Profile' },
    });
  }
  location.href = 'https://tiktok.com.evil.test/';
  expect(readPageProfile()).toBeNull();
});

test('TikTok worker drops profile if uid differs from probe or changes at confirmation; explicit tab only', async () => {
  const c = fakeChrome({ tabs: [{ url: 'https://www.tiktok.com/', active: true }] });
  page({ uid, uniqueId: 'alice', nickname: 'Alice Profile' });
  c.scripting.executeScript = async ({ func, target }) => {
    expect(target.tabId).toBe(1);
    return [{ frameId: 0, result: func() }];
  };
  const deps = { ...c, currentIdentity: async () => uid };
  expect(await readProfile(deps, 'tiktok', uid, 1)).toEqual({
    displayName: 'Alice Profile',
    handle: 'alice',
  });
  expect(await readProfile(deps, 'tiktok', '999', 1)).toBeUndefined();
  expect(
    await readProfile({ ...deps, currentIdentity: async () => '999' }, 'tiktok', uid, 1),
  ).toBeUndefined();
  expect(await readProfile(deps, 'tiktok', uid)).toBeUndefined();
});
