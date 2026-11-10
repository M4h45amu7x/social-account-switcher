import { expect, test } from 'bun:test';
import type { PopupState } from '../../src/background/router';
import { type Account, migrate } from '../../src/lib/store';
import { fakeChrome } from '../fakes/chrome';
import { loginAs, PASSWORD, startWorker } from '../fakes/harness';

async function setup(platform: 'facebook' | 'instagram' | 'youtube' = 'facebook') {
  const h = await startWorker(
    fakeChrome({ tabs: [{ url: `https://www.${platform}.com/`, active: true }] }),
  );
  await h.must({ type: 'vault.setup', password: PASSWORD });
  if (platform !== 'youtube') await loginAs(h.chrome, platform, '1001');
  const tabId = h.chrome.tabs.tabs[0]?.id as number;
  h.youtube.current = { ok: true, value: { authuser: 1 } };
  const identity = platform === 'youtube' ? { authuser: 1 } : '1001';
  const page = (name: string, id: unknown = identity) =>
    h.chrome.scripting.pageResults.set(tabId, {
      identity: id,
      profile: { displayName: name, handle: '@alice', email: 'a@example.test', extra: 'drop' },
    });
  page('Alice');
  return { h, tabId, page, platform };
}
for (const platform of ['facebook', 'instagram', 'youtube'] as const) {
  test(`${platform}: probe, automatic add and refresh use matched page metadata; rename is permanent`, async () => {
    const { h, tabId, page } = await setup(platform);
    const probe = await h.must({ type: 'account.probe', platform, tabId });
    expect(probe).toMatchObject({ profile: { displayName: 'Alice', handle: '@alice' } });
    const a = await h.must<Account>({
      type: 'account.addCurrent',
      platform,
      tabId,
      label: 'old prefill',
      autoLabel: true,
    });
    expect(a).toMatchObject({
      label: 'Alice',
      labelSource: 'profile',
      profile: { displayName: 'Alice' },
    });
    page('New Name');
    await h.must({ type: 'account.updateSession', accountId: a.id, tabId });
    let state = await h.must<PopupState>({ type: 'state.get' });
    expect(state.accounts[0]).toMatchObject({
      label: 'New Name',
      profile: { displayName: 'New Name' },
    });
    await h.must({ type: 'account.rename', accountId: a.id, label: 'New Name' });
    page('Latest Name');
    await h.must({ type: 'account.updateSession', accountId: a.id, tabId });
    state = await h.must<PopupState>({ type: 'state.get' });
    expect(state.accounts[0]).toMatchObject({
      label: 'New Name',
      labelSource: 'custom',
      profile: { displayName: 'Latest Name' },
    });
    expect(JSON.stringify(state)).not.toContain('"extra"');
  });
}
test('mismatch or missing profile cannot retain stale prefill; custom label survives refresh failure', async () => {
  const { h, tabId, page } = await setup();
  page('Stranger', '9999');
  expect(await h.must({ type: 'account.probe', platform: 'facebook', tabId })).not.toHaveProperty(
    'profile',
  );
  const a = await h.must<Account>({
    type: 'account.addCurrent',
    platform: 'facebook',
    tabId,
    label: 'stale name',
    autoLabel: true,
  });
  expect(a.label).toBe('Facebook');
  expect(a).not.toHaveProperty('profile');
  await h.must({ type: 'account.rename', accountId: a.id, label: 'My label' });
  page('Alice');
  await h.must({ type: 'account.updateSession', accountId: a.id, tabId });
  page('Stranger', '9999');
  await h.must({ type: 'account.updateSession', accountId: a.id, tabId });
  const state = await h.must<PopupState>({ type: 'state.get' });
  expect(state.accounts[0]).toMatchObject({ label: 'My label' });
  expect(state.accounts[0]).not.toHaveProperty('profile');
});
test('migration sanitizes optional metadata without quarantining old accounts or overriding legacy labels', async () => {
  const { h, tabId } = await setup();
  const a = await h.must<Account>({
    type: 'account.addCurrent',
    platform: 'facebook',
    tabId,
    label: 'Legacy',
  });
  const raw = h.chrome.storage.local.dump().store as Record<string, unknown>;
  const result = migrate({
    ...raw,
    accounts: [
      {
        ...a,
        profile: { displayName: 'A\u202eB', avatar: 'https://cdn.test/a.png', extra: 'drop' },
        labelSource: 'unknown',
      },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.accounts[0]).toMatchObject({
    label: 'Legacy',
    profile: { displayName: 'A B' },
  });
  expect(result.value.accounts[0]).not.toHaveProperty('labelSource');
  expect(result.value.quarantine).toBeUndefined();
});
test('both wipes erase profiles, including derived YouTube labels and quarantined copies', async () => {
  for (const scope of ['sessions', 'all'] as const) {
    const { h, tabId } = await setup('youtube');
    await h.must({
      type: 'account.addCurrent',
      platform: 'youtube',
      tabId,
      label: 'prefill',
      autoLabel: true,
    });
    const raw = h.chrome.storage.local.dump().store as Record<string, unknown>;
    await h.chrome.storage.local.set({
      store: { ...raw, quarantine: [{ profile: { email: 'a@example.test' } }] },
    });
    await h.must({ type: 'vault.wipe', scope });
    const dump = JSON.stringify(h.chrome.storage.local.dump());
    expect(dump).not.toContain('Alice');
    expect(dump).not.toContain('a@example.test');
    expect(dump).not.toContain('profile');
    const state = await h.must<PopupState>({ type: 'state.get' });
    expect(state.accounts.length).toBe(scope === 'sessions' ? 1 : 0);
    if (scope === 'sessions') expect(state.accounts[0]?.label).toBe('YouTube');
  }
});
