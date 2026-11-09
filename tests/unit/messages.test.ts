// docs/design.md 8.3 test 10: malformed messages and foreign senders are refused.
import { describe, expect, test } from 'bun:test';
import { isTrustedSender, MAX_FIELD_LENGTH, parseRequest } from '../../src/lib/messages';
import { withAccounts } from '../fakes/harness';

const ID = 'abcdefghijklmnopabcdefghijklmnop';

describe('parseRequest', () => {
  test.each([
    { type: 'state.get' },
    { type: 'vault.unlock', password: 'pw' },
    { type: 'vault.lock' },
    { type: 'vault.setup', password: 'pw' },
    { type: 'vault.wipe' },
    { type: 'settings.set', theme: 'dark' },
    { type: 'settings.set', language: 'th', theme: undefined },
    { type: 'settings.set' },
    { type: 'account.addCurrent', platform: 'youtube', label: 'x' },
    { type: 'account.updateSession', accountId: 'a' },
    { type: 'account.rename', accountId: 'a', label: '' },
    { type: 'account.remove', accountId: 'a' },
    { type: 'account.switch', accountId: 'a' },
    { type: 'account.switch', accountId: 'a', force: true },
  ])('accepts %p', (m) => {
    expect(parseRequest(m)).toEqual({ ok: true, value: m as never });
  });

  class Fake {
    type = 'state.get';
  }
  test.each([
    ['not an object', 'state.get'],
    ['null', null],
    ['an array', [{ type: 'state.get' }]],
    ['a class instance', new Fake()],
    ['no type', {}],
    ['an unknown type', { type: 'cookies.dump' }],
    ['a type from Object.prototype', { type: 'toString' }],
    ['an extra field', { type: 'vault.lock', password: 'x' }],
    ['a missing field', { type: 'vault.unlock' }],
    ['an empty password', { type: 'vault.unlock', password: '' }],
    ['a password that is not a string', { type: 'vault.setup', password: 123456789012 }],
    ['an over-long field', { type: 'vault.unlock', password: 'x'.repeat(MAX_FIELD_LENGTH + 1) }],
    ['an unknown platform', { type: 'account.addCurrent', platform: 'tiktok', label: 'x' }],
    ['an unknown theme', { type: 'settings.set', theme: 'neon' }],
    ['force that is not boolean', { type: 'account.switch', accountId: 'a', force: 'yes' }],
    ['a required field set to undefined', { type: 'account.remove', accountId: undefined }],
  ])('refuses %s', (_why, m) => {
    expect(parseRequest(m)).toEqual({ ok: false, error: 'bad_request' });
  });
});

describe('keys inherited from Object.prototype', () => {
  const INHERITED = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

  test.each(INHERITED)('a %s field is refused, not thrown', (key) => {
    // JSON.parse makes even __proto__ an own key, as a structured-clone message would.
    const message: unknown = JSON.parse(`{"type":"state.get","${key}":1}`);
    expect(Object.hasOwn(message as object, key)).toBe(true);
    expect(parseRequest(message)).toEqual({ ok: false, error: 'bad_request' });
  });

  test.each(INHERITED)('the router answers a %s field with a Result', async (key) => {
    const { h } = await withAccounts();
    const answer = h.send(JSON.parse(`{"type":"vault.lock","${key}":1}`));
    expect(await answer).toEqual({ ok: false, error: 'bad_request' });
    expect((await h.send({ type: 'state.get' })).ok).toBe(true);
  });

  test('a message that throws while it is read gets internal, never a rejection', async () => {
    // Chrome's structured clone would refuse a Proxy, so this goes to the handler directly: it
    // stands for any parsing bug, like the inherited keys above.
    const { h } = await withAccounts();
    const hostile = new Proxy(
      { type: 'state.get' },
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(await h.router.handle(hostile, h.chrome.runtime.popupSender)).toEqual({
      ok: false,
      error: 'internal',
    });
  });
});

describe('isTrustedSender', () => {
  const popup = { id: ID, url: `chrome-extension://${ID}/popup/index.html` };
  test("the extension's own popup, also when opened in a tab", () => {
    expect(isTrustedSender(popup, ID)).toBe(true);
    expect(isTrustedSender({ ...popup, tab: { id: 4 } }, ID)).toBe(true);
  });
  test.each([
    ['another extension', { ...popup, id: 'b'.repeat(32) }],
    [
      'a page of another extension claiming our id',
      { id: ID, url: `chrome-extension://${'b'.repeat(32)}/x.html` },
    ],
    ['a content script in a tab', { id: ID, url: 'https://www.facebook.com/', tab: { id: 1 } }],
    ['a web page', { url: 'https://www.facebook.com/' }],
    ['no url', { id: ID }],
    ['nothing at all', {}],
  ])('refuses %s', (_why, sender) => {
    expect(isTrustedSender(sender, ID)).toBe(false);
  });
  test('an empty extension id trusts nobody', () => {
    expect(isTrustedSender({ id: '', url: 'chrome-extension:///' }, '')).toBe(false);
  });
});

describe('the router refuses before doing anything', () => {
  test('a foreign sender gets forbidden and changes nothing', async () => {
    const { h, ids } = await withAccounts();
    const before = JSON.stringify([h.chrome.storage.local.dump(), h.chrome.cookies.all()]);
    for (const m of [
      { type: 'vault.wipe' },
      { type: 'account.switch', accountId: ids['1001'] },
      { type: 'state.get' },
    ]) {
      expect(await h.chrome.runtime.send(m, { id: 'evil', url: 'https://evil.example/' })).toEqual({
        ok: false,
        error: 'forbidden',
      });
      expect(
        await h.chrome.runtime.send(m, {
          id: h.chrome.runtime.id,
          url: 'https://www.facebook.com/',
          tab: { id: 3 },
        }),
      ).toEqual({ ok: false, error: 'forbidden' });
    }
    expect(JSON.stringify([h.chrome.storage.local.dump(), h.chrome.cookies.all()])).toBe(before);
  });

  test('a malformed message gets bad_request', async () => {
    const { h } = await withAccounts();
    expect(await h.send({ type: 'vault.wipe', now: true })).toEqual({
      ok: false,
      error: 'bad_request',
    });
    expect(await h.send('vault.wipe')).toEqual({ ok: false, error: 'bad_request' });
    expect((await h.send({ type: 'state.get' })).ok).toBe(true);
  });
});
