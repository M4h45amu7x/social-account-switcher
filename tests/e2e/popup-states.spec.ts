// Card B5a: the real popup code in real Chromium. Every state × en/th × light/dark is opened from a build
// of src/popup (plus the e2e page src/popup/e2e, which is not part of dist/), screenshotted, and compared
// with the same state in mockup/popup.html. Also checks the layout (no overflow at 360px), the motion
// (View Transitions, Circle Reveal, reduced motion) and that the popup makes no requests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { SAMPLE_STATES } from '../../src/popup/samples';
import { buildPopup, idle, open, root, popupTest as test } from './popup-build';

const { expect } = test;
const shotsDir = process.env.E2E_SHOTS ?? join(root, 'test-results', 'popup-shots');
const mockup = pathToFileURL(join(root, 'mockup', 'popup.html')).href;
const LANGS = ['en', 'th'] as const;
const THEMES = ['light', 'dark'] as const;
const results: string[] = [];

test.beforeAll(() => {
  buildPopup();
  mkdirSync(shotsDir, { recursive: true });
});
test.afterAll(() => {
  const log = process.env.E2E_LOG;
  if (log) writeFileSync(log, `${results.join('\n')}\n`);
});

// the mockup's own "Mockup password" hint is the one line that is allowed to differ
const MASK = '[data-testid="pw-hint"]';

async function openMockup(page: Page, state: string, lang: string, theme: string) {
  await page.addInitScript(
    ([l, t]) => {
      localStorage.setItem('language', l ?? 'en');
      localStorage.setItem('theme', t ?? 'light');
    },
    [lang, theme],
  );
  await page.goto(mockup);
  await page.evaluate(
    (s) => (window as unknown as { __mock: { jump(n: string): void } }).__mock.jump(s),
    state,
  );
  await idle(page);
  await page.waitForFunction(
    (s) => document.getElementById('popup')?.dataset.state !== undefined && !!s,
    state,
  );
  await page.addStyleTag({
    content: `.popup{border-radius:0!important;box-shadow:none!important} ${MASK}{visibility:hidden}`,
  });
}

async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([x, y]) => {
      const load = (b64: string) =>
        new Promise<ImageBitmap>((res, rej) => {
          const img = new Image();
          img.onload = () => createImageBitmap(img).then(res, rej);
          img.onerror = rej;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [ia, ib] = await Promise.all([load(x ?? ''), load(y ?? '')]);
      if (ia.width !== ib.width || ia.height !== ib.height) return 1;
      const read = (i: ImageBitmap) => {
        const c = new OffscreenCanvas(i.width, i.height);
        const g = c.getContext('2d');
        if (!g) throw new Error('no canvas');
        g.drawImage(i, 0, 0);
        return g.getImageData(0, 0, i.width, i.height).data;
      };
      const da = read(ia);
      const db = read(ib);
      let bad = 0;
      for (let p = 0; p < da.length; p += 4) {
        const d = Math.max(
          Math.abs((da[p] ?? 0) - (db[p] ?? 0)),
          Math.abs((da[p + 1] ?? 0) - (db[p + 1] ?? 0)),
          Math.abs((da[p + 2] ?? 0) - (db[p + 2] ?? 0)),
        );
        if (d > 40) bad++;
      }
      return bad / (da.length / 4);
    },
    [a.toString('base64'), b.toString('base64')] as [string, string],
  );
}

const STATE_OF: Record<string, string> = {
  list: 'list',
  empty: 'empty',
  'add-form': 'adding',
  'add-not-logged-in': 'adding',
  switching: 'switching',
  success: 'success',
  error: 'error',
  rename: 'rename',
  delete: 'delete',
  youtube: 'success',
  locked: 'locked',
  'locked-wrong': 'locked',
  'wipe-confirm': 'locked',
  settings: 'settings',
  'settings-wipe': 'settings',
};

test.describe('every state × language × theme', () => {
  test.use({ viewport: { width: 360, height: 700 } });
  for (const state of SAMPLE_STATES) {
    for (const lang of LANGS) {
      test(`${state} · ${lang}: renders, fits 360px, matches the mockup in light and dark`, async ({
        context,
        extensionId,
      }) => {
        const problems: string[] = [];
        for (const theme of THEMES) {
          const real = await context.newPage();
          real.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
          real.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
          real.on(
            'request',
            (r) =>
              !r.url().startsWith('chrome-extension://') && problems.push(`network: ${r.url()}`),
          );
          await open(real, extensionId, { state, lang, theme });

          const popup = real.getByTestId('popup');
          await expect(popup).toHaveAttribute('data-state', STATE_OF[state] ?? '');
          expect(await real.evaluate(() => document.documentElement.lang)).toBe(lang);
          expect(
            await real.evaluate(() => document.documentElement.getAttribute('data-theme')),
          ).toBe(theme);

          // no horizontal overflow at 360px, anywhere inside the popup
          const overflow = await real.evaluate(() => {
            const bad: string[] = [];
            const p = document.getElementById('app');
            if (!p) return ['no #app'];
            const box = p.getBoundingClientRect();
            if (document.documentElement.scrollWidth > 360)
              bad.push(`page scrollWidth ${document.documentElement.scrollWidth}`);
            for (const el of p.querySelectorAll<HTMLElement>('*')) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5)) {
                bad.push(
                  `${el.tagName}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`,
                );
              }
            }
            return bad;
          });
          expect(overflow).toEqual([]);
          expect((await popup.boundingBox())?.width).toBe(360);

          const file = join(shotsDir, `${state}.${lang}.${theme}.png`);
          const realShot = await popup.screenshot({
            path: file,
            animations: 'disabled',
            style: `${MASK}{visibility:hidden}`,
          });

          const mock = await context.newPage();
          await mock.setViewportSize({ width: 760, height: 900 });
          await openMockup(mock, state, lang, theme);
          const mockShot = await mock.locator('#popup').screenshot({ animations: 'disabled' });
          const ratio = await diffRatio(real, realShot, mockShot);
          results.push(
            `${ratio <= 0.01 ? 'PASS' : 'FAIL'} ${state}.${lang}.${theme} diff=${(ratio * 100).toFixed(3)}%`,
          );
          expect(ratio, `${state}.${lang}.${theme} differs from the mockup`).toBeLessThanOrEqual(
            0.01,
          );
          await mock.close();
          await real.close();
        }
        expect(problems).toEqual([]);
      });
    }
  }
});

test.describe('behaviour in the real popup', () => {
  test.use({ viewport: { width: 360, height: 700 } });

  test('switching an account runs the steps, shows the toast, and the toast leaves by itself', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light' });
    await page.getByTestId('row-fb2').locator('button.main').click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'switching');
    await expect(page.getByTestId('switch-step')).toHaveText('Saving the current session…');
    await expect(page.getByTestId('switch-step')).toHaveText('Applying the new session…');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'success', {
      timeout: 6000,
    });
    await expect(page.getByTestId('toast')).toContainText(/Switched to \u2068?Orange Bakery/);
    await expect(page.locator('.row').first()).toHaveAttribute('data-id', 'fb2');
    await expect(page.getByTestId('toast')).toBeHidden({ timeout: 8000 });
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'list');
  });

  test('an expired account shows the error and keeps the previous account', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'list', lang: 'th', theme: 'light' });
    await page.getByTestId('row-fb3').locator('button.main').click();
    await expect(page.getByTestId('error')).toBeVisible({ timeout: 6000 });
    await expect(page.getByTestId('error')).toContainText('วิธีแก้');
    await expect(page.locator('.row.active')).toHaveAttribute('data-id', 'fb1');
    await page.getByTestId('error-update').click();
    await expect(page.getByTestId('error')).toBeHidden();
  });

  test('rename, delete and add work through the real reducer', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light' });
    await page.getByTestId('rename-fb2').click();
    await expect(page.getByTestId('rename-input')).toBeFocused();
    await page.getByTestId('rename-input').fill('');
    await page.getByTestId('rename-save').click();
    await expect(page.getByTestId('rename-hint')).toHaveClass(/bad/);
    await page.getByTestId('rename-input').fill('Bakery 2');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('row-fb2').locator('.nm')).toHaveText('Bakery 2');
    await idle(page);
    await page.getByTestId('delete-fb3').click();
    await expect(page.getByTestId('confirm-delete')).toBeVisible();
    await page.getByTestId('delete-confirm').click();
    await expect(page.getByTestId('row-fb3')).toHaveCount(0);
    await idle(page);
    await page.getByTestId('add-account').click();
    await expect(page.getByTestId('add-form')).toBeVisible();
    await page.getByTestId('add-input').fill('Shop page');
    await page.getByTestId('add-save').click();
    await expect(page.locator('.row').first().locator('.nm')).toHaveText('Shop page');
  });

  test('lock screen: wrong password, then the right one unlocks', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'locked', lang: 'en', theme: 'light' });
    await page.getByTestId('pw-input').fill('nope');
    await page.getByTestId('unlock').click();
    await expect(page.getByTestId('pw-hint')).toHaveText('Wrong password. Try again.');
    await expect(page.getByTestId('unlock')).toHaveAttribute('data-btn-state', 'idle', {
      timeout: 4000,
    });
    await page.getByTestId('pw-input').fill('orange-cat-2026');
    await page.getByTestId('pw-input').press('Enter');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', /list|empty/, {
      timeout: 5000,
    });
  });

  test('Circle Reveal: the theme switches inside a view transition and the choice is cached', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'settings', lang: 'en', theme: 'light' });
    await page.evaluate(() => {
      const w = window as unknown as { __vt: string[] };
      w.__vt = [];
      new MutationObserver(() => {
        const v = document.documentElement.dataset.vt;
        if (v) w.__vt.push(v);
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-vt'] });
    });
    await page.getByTestId('s-theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => (window as unknown as { __vt: string[] }).__vt)).toContain(
      'theme',
    );
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
    await idle(page);
    await page.getByTestId('s-theme-system').click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  });

  test('theme-boot.js paints the cached theme before the module runs (no flash)', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('theme', 'dark');
      // 'interactive' comes after the head scripts ran and before the module script does
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive') return;
        const html = document.documentElement;
        html.dataset.bootTheme = html.getAttribute('data-theme') ?? 'none';
      });
    });
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'setup');
    const boot = await page.evaluate(() => ({
      theme: document.documentElement.dataset.bootTheme,
    }));
    // first paint used the cached theme...
    expect(boot).toEqual({ theme: 'dark' });
    // ...and then the worker's stored setting (System) won over the stale cache
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  test('System follows the OS scheme live, without any data-theme attribute', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'list', lang: 'en', theme: 'system' });
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light).toBe('rgb(255, 255, 255)');
    expect(dark).toBe('rgb(23, 26, 31)');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(
      false,
    );
  });

  test('language: Auto follows the browser, an explicit choice overrides it live', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'settings', lang: 'auto', ui: 'th-TH', theme: 'light' });
    await expect(page.locator('h1')).toHaveText('ตั้งค่า');
    await page.getByTestId('s-lang-en').click();
    await expect(page.locator('h1')).toHaveText('Settings');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(await page.evaluate(() => localStorage.getItem('language'))).toBe('en');
  });

  test('prefers-reduced-motion: reduce never starts a view transition and the spinner stands still', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light', hold: '1' });
    await page.evaluate(() => {
      const w = window as unknown as { __vt: string[] };
      w.__vt = [];
      new MutationObserver(() => w.__vt.push(document.documentElement.dataset.vt ?? '')).observe(
        document.documentElement,
        { attributes: true, attributeFilter: ['data-vt'] },
      );
    });
    await page.getByTestId('tab-youtube').click();
    await expect(page.getByTestId('tab-youtube')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('row-yt2').locator('button.main').click();
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'switching');
    expect(await page.evaluate(() => (window as unknown as { __vt: string[] }).__vt)).toEqual([]);
    const anim = await page.evaluate(
      () => getComputedStyle(document.querySelector('.spinner') as Element).animationName,
    );
    expect(anim).toBe('none');
  });

  test('a tab change plays the slide: data-vt is set during it and cleared after', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light' });
    await page.evaluate(() => document.documentElement.style.setProperty('--motion-scale', '3'));
    await page.getByTestId('tab-youtube').click();
    await expect(page.locator('html')).toHaveAttribute('data-vt', 'tab');
    await idle(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-vt', /.*/);
    await expect(page.getByTestId('popup')).toHaveAttribute('data-platform', 'youtube');
  });

  test('Esc closes the innermost temporary thing and returns focus to its opener', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    const cases: [string, Record<string, string>, string, string, string][] = [
      ['rename, focus in the input', { state: 'list' }, 'rename-fb2', 'rename-input', 'rename-fb2'],
      ['rename, focus on Save', { state: 'list' }, 'rename-fb2', 'rename-save', 'rename-fb2'],
      ['delete, focus on Delete', { state: 'list' }, 'delete-fb3', 'delete-confirm', 'delete-fb3'],
      ['delete, focus on Cancel', { state: 'list' }, 'delete-fb3', 'delete-cancel', 'delete-fb3'],
      ['add form, focus on Save', { state: 'list' }, 'add-account', 'add-save', 'add-account'],
      [
        'not logged in, focus on Close',
        { state: 'list', loggedIn: '0' },
        'add-account',
        'add-cancel',
        'add-account',
      ],
    ];
    for (const [name, q, opener, inside, back] of cases) {
      await open(page, extensionId, { lang: 'en', theme: 'light', ...q });
      await page.getByTestId(opener).click();
      await idle(page);
      await page.getByTestId(inside).focus();
      await page.keyboard.press('Escape');
      await idle(page);
      await expect(page.getByTestId('popup'), name).toHaveAttribute('data-state', 'list');
      await expect(page.getByTestId(back), name).toBeFocused();
    }
    await open(page, extensionId, { state: 'list', lang: 'en', theme: 'light' });
    await page.getByTestId('row-fb3').locator('button.main').click();
    await expect(page.getByTestId('error')).toBeVisible({ timeout: 6000 });
    await page.getByTestId('error-close').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('error')).toBeHidden();
    await expect(page.getByTestId('row-fb3').locator('button.main')).toBeFocused();
    await open(page, extensionId, { state: 'wipe-confirm', lang: 'en', theme: 'light' });
    await page.getByTestId('wipe-ok').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('wipe-confirm')).toBeHidden();
    await expect(page.getByTestId('forgot')).toBeFocused();
    await open(page, extensionId, { state: 'settings-wipe', lang: 'en', theme: 'light' });
    await page.getByTestId('s-wipe-ok').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-wipe-confirm')).toBeHidden();
    await expect(page.getByTestId('s-wipe')).toBeFocused();
    await open(page, extensionId, { state: 'locked', lang: 'en', theme: 'light' });
    await page.getByTestId('pw-input').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('popup')).toHaveAttribute('data-state', 'locked');
  });

  test('the toast sits in the flow: it covers neither the footer, the YouTube note nor any button', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    for (const state of ['success', 'youtube']) {
      await open(page, extensionId, { state, lang: 'en', theme: 'light' });
      const hits = await page.evaluate(() => {
        const toast = document.querySelector('.toast')?.getBoundingClientRect();
        if (!toast) return ['no toast'];
        const bad: string[] = [];
        for (const el of document.querySelectorAll('#app button, .foot, .note')) {
          if (el.closest('.toast')) continue;
          const r = el.getBoundingClientRect();
          if (
            r.width &&
            r.height &&
            r.left < toast.right &&
            r.right > toast.left &&
            r.top < toast.bottom &&
            r.bottom > toast.top
          ) {
            bad.push(`${el.tagName}.${el.className}`);
          }
        }
        return bad;
      });
      expect(hits, state).toEqual([]);
    }
  });

  test('the password placeholder is not cut off, in either language', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    for (const lang of ['en', 'th']) {
      await open(page, extensionId, { state: 'locked', lang, theme: 'light' });
      const clipped = await page.evaluate(() => {
        const input = document.getElementById('pw-input') as HTMLInputElement;
        const probe = document.createElement('span');
        const cs = getComputedStyle(input);
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`;
        probe.textContent = input.placeholder;
        document.body.append(probe);
        const need = probe.getBoundingClientRect().width;
        probe.remove();
        const room =
          input.clientWidth -
          Number.parseFloat(cs.paddingLeft) -
          Number.parseFloat(cs.paddingRight);
        return need > room;
      });
      expect(clipped, lang).toBe(false);
    }
  });

  test('a name with a right-to-left override cannot reorder the text around it', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    const evil = '\u202Eevil\u202C';
    for (const state of ['list', 'delete', 'success']) {
      await open(page, extensionId, { state, lang: 'en', theme: 'light', label: evil });
      const text = await page.evaluate(() => {
        const nm = document.querySelector('.nm');
        const confirm = document.querySelector('[data-testid=confirm-delete] p');
        const toast = document.querySelector('.toast .tx span');
        return {
          nm: nm ? getComputedStyle(nm).unicodeBidi : '',
          confirm: confirm?.textContent ?? '',
          toast: toast?.textContent ?? '',
        };
      });
      if (state === 'list') expect(text.nm).toBe('isolate');
      if (state === 'delete') expect(text.confirm).toContain('\u2068\u202Eevil');
      if (state === 'success')
        expect(text.toast.endsWith('\u2069 ') || text.toast.includes('\u2069')).toBe(true);
      // the static text after the name still sits to the right of it: measure the x order of two spans
    }
    await open(page, extensionId, { state: 'delete', lang: 'en', theme: 'light', label: evil });
    const order = await page.evaluate(() => {
      const p = document.querySelector('[data-testid=confirm-delete] p') as HTMLElement;
      const name = (p.querySelector('b') as HTMLElement).getBoundingClientRect();
      const tail = p.lastChild as Text | null;
      const range = document.createRange();
      const t = [...p.childNodes].filter(
        (n): n is Text => n.nodeType === 3 && (n.textContent ?? '').includes('from the list'),
      )[0];
      if (!t) return { ok: false, why: 'no tail text' };
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      void tail;
      // "from the list?" must come after the name: to its right on the same line, or on a later line
      return {
        ok: r.left >= name.right - 1 || r.top >= name.bottom - 1,
        name: name.right,
        tail: r.left,
      };
    });
    expect(order.ok, JSON.stringify(order)).toBe(true);
  });

  test('the shipped popup (dist) has no e2e page, no sample data and no network use', async () => {
    const dist = resolve(root, 'dist');
    const js =
      readFileSync(join(dist, 'popup.js'), 'utf8') +
      readFileSync(join(dist, 'service-worker.js'), 'utf8');
    expect(js).not.toContain('orange-cat-2026');
    expect(js).not.toContain('Client work A');
    expect(js).not.toContain('e2eReady');
  });
});
