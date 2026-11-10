// Required-host denial uses an actual manifest without TikTok access, not a mocked API rejection.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeTikTok, TT } from './fake-tiktok';
import { launchExtension } from './fixtures';
import { startHttpsSites } from './https-sites';
import { buildTikTok, tiktokDist } from './tiktok-build';
import { PASSWORD, send, worker } from './tiktok-helpers';

test('TikTok: missing actual host permission refuses probe/add without changing encrypted store or browser cookies', async () => {
  buildTikTok();
  const deniedDir = resolve(tiktokDist, '../tiktok-denied-dist');
  cpSync(tiktokDist, deniedDir, { recursive: true });
  const manifestPath = resolve(deniedDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions: string[] };
  manifest.host_permissions = manifest.host_permissions.filter((host) => !host.includes('tiktok'));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const fake = fakeTikTok();
  const sites = await startHttpsSites([TT], fake.handler);
  const launched = await launchExtension({ dir: deniedDir, extraArgs: sites.args }).catch(
    async (error) => {
      await sites.close();
      throw error;
    },
  );
  try {
    const sw = await worker(launched.context);
    const id = new URL(sw.url()).host;
    const popup = await launched.context.newPage();
    await popup.goto(`chrome-extension://${id}/popup/index.html`);
    expect(await send(popup, { type: 'vault.setup', password: PASSWORD })).toEqual({ ok: true });
    const tab = await launched.context.newPage();
    await tab.goto(`https://${TT}/__e2e/login?user=alice`);
    await tab.bringToFront();
    const tabId = await sw.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
    );
    expect(tabId).toBeDefined();
    const stored = await sw.evaluate(() => chrome.storage.local.get(null));
    const cookies = await launched.context.cookies();
    expect(
      await sw.evaluate(() => chrome.permissions.contains({ origins: ['https://*.tiktok.com/*'] })),
    ).toBe(false);
    // Without the host grant, Chrome withholds this tab's URL, so the contextual reader refuses it.
    expect(await send(popup, { type: 'account.probe', platform: 'tiktok', tabId })).toEqual({
      ok: false,
      error: 'no_tiktok_tab',
    });
    expect(
      await send(popup, { type: 'account.addCurrent', platform: 'tiktok', label: 'Denied', tabId }),
    ).toEqual({ ok: false, error: 'no_tiktok_tab' });
    expect(await sw.evaluate(() => chrome.storage.local.get(null))).toEqual(stored);
    expect(await launched.context.cookies()).toEqual(cookies);
    expect(await sw.evaluate(() => chrome.storage.session.get('journal.tiktok'))).toEqual({});
  } finally {
    try {
      await launched.close();
    } finally {
      await sites.close();
    }
  }
});
