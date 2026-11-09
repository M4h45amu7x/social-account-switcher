// e2e for mockup/popup.html (v2): every state, English + Thai, light + dark, all six transitions,
// reduced motion, no View Transitions support, layout overflow, contrast, no console error / dialog / network.
// How to run + environment variables: see mockup/README.md
// Output: mockup/shots/<lang>-<theme>-<state>.png · mockup/e2e/e2e.log · exit 1 if any check fails
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mockupDir = resolve(here, '..');
const shotsDir = join(mockupDir, 'shots');
const logFile = process.env.E2E_LOG ? resolve(process.env.E2E_LOG) : join(here, 'e2e.log');
const htmlPath = process.env.POPUP_HTML ? resolve(process.env.POPUP_HTML) : join(mockupDir, 'popup.html');
const writeShots = process.env.E2E_SHOTS !== '0';
const repoRoot = resolve(mockupDir, '..');
const rel = (p) => relative(repoRoot, p);
if (writeShots) mkdirSync(shotsDir, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.error('Cannot find playwright. Set PLAYWRIGHT_MODULE=<path>/node_modules/playwright');
  process.exit(2);
}

const lines = [];
const t0 = Date.now();
const log = (s) => {
  const line = `[${String(Date.now() - t0).padStart(6)}ms] ${s}`;
  lines.push(line);
  console.log(line);
};
let pass = 0;
let fail = 0;
let problems = [];

async function step(name, fn) {
  try {
    await fn();
    pass++;
    log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    log(`FAIL  ${name} - ${String(e.message || e).split('\n')[0]}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

/** Opens a fresh page with the policy guards (no dialog, no network, no console error). */
async function open(ctxOpts = {}, init) {
  const context = await browser.newContext({
    viewport: { width: 760, height: 720 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-US',
    ...ctxOpts,
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT || 6000));
  page.on('dialog', async (d) => {
    problems.push(`dialog ${d.type()}: ${d.message()}`);
    await d.dismiss();
  });
  page.on('request', (r) => {
    if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) problems.push(`network request: ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(pathToFileURL(htmlPath).href);
  const popup = page.getByTestId('popup');
  const tid = (id) => page.getByTestId(id);
  const api = {
    context,
    page,
    popup,
    tid,
    state: () => popup.getAttribute('data-state'),
    waitPlatform: (p) => page.waitForFunction((v) => document.getElementById('popup').dataset.platform === v, p, { timeout: 5000 }),
    waitState: (s, timeout = 5000) =>
      page.waitForFunction((v) => document.getElementById('popup').dataset.state === v, s, { timeout }),
    idle: () => page.waitForFunction(() => !document.documentElement.dataset.vtBusy, null, { timeout: 5000 }),
    /** text from the mockup's own i18n table, so the same checks run in both languages */
    tx: (key, params) => page.evaluate(([k, p]) => ta(k, p), [key, params || {}]),
    /** collect every animation that targets a view-transition pseudo-element while `action` runs */
    watch: async (action, ms = 1500) => {
      const w = page.evaluate(
        (ms) =>
          new Promise((res) => {
            const seen = new Map();
            const start = performance.now();
            (function loop() {
              for (const a of document.getAnimations()) {
                const e = a.effect;
                const pe = e && e.pseudoElement;
                const name = a.animationName || '';
                if (pe && (!seen.has(pe) || (name.startsWith('vt-') && !seen.get(pe).name.startsWith('vt-')))) seen.set(pe, { name, kf: JSON.stringify(e.getKeyframes()).slice(0, 400) });
              }
              if (performance.now() - start < ms) requestAnimationFrame(loop);
              else res([...seen.entries()]);
            })();
          }),
        ms,
      );
      w.catch(() => {});   // never leave a dangling rejection if the action throws
      await action();
      return new Map(await w);
    },
    jump: async (s) => {
      await tid(`demo-${s}`).click();
      const want = { 'add-form': 'adding', 'add-not-logged-in': 'adding', youtube: 'success', 'locked-wrong': 'locked', 'wipe-confirm': 'locked', 'settings-wipe': 'settings' }[s] || s;
      await api.waitState(want);
      await api.idle();
      await page.waitForTimeout(80);
    },
    setLang: async (l) => {
      await tid(`lang-${l}`).click();
      await page.waitForFunction((v) => document.documentElement.lang === v, l === 'auto' ? 'en' : l);
      await api.idle();
    },
    setTheme: async (th) => {
      await tid(`theme-${th}`).click();
      await page.waitForFunction((v) => document.documentElement.dataset.theme === v, th);
      await api.idle();
    },
  };
  return api;
}

/** Layout check used in every state and language: nothing sticks out, nothing is clipped. */
const layoutProblems = (popup) =>
  popup.evaluate((p) => {
    const out = [];
    const pr = p.getBoundingClientRect();
    if (Math.round(pr.width) !== 360) out.push(`popup width ${pr.width}`);
    for (const el of p.querySelectorAll('*')) {
      if (el.closest('.sr') || el.tagName === 'svg' || el.closest('svg') || el.classList.contains('sr')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const label = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || '').trim().slice(0, 30)}"`;
      if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5) out.push(`outside popup: ${label}`);
      const cs = getComputedStyle(el);
      if (el.tagName !== 'INPUT' && !el.classList.contains('avatar') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.push(`text cut/overflow (x): ${label}`);
      if ((cs.overflowY === 'hidden' || cs.overflowX === 'hidden') && el !== p && el.scrollHeight > el.clientHeight + 1) out.push(`clipped (y): ${label}`);
    }
    return out;
  });

const hasThai = (s) => /[฀-๿]/.test(s);

try {
  log(`open ${rel(htmlPath)} · browser ${browser.version()}`);

  // ------------------------------------------------------------------ file hygiene
  const src = readFileSync(htmlPath, 'utf8');
  const code = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  await step('file: no chrome.* call, no alert/confirm/prompt, no outside URL, no fetch', async () => {
    const script = code.slice(code.lastIndexOf('<script>'));
    expect(!/\bchrome\.[a-z]/.test(script), 'chrome.* found');
    expect(!/\b(alert|confirm|prompt)\s*\(/.test(script), 'alert/confirm/prompt found');
    expect(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(script), 'network API found');
    expect(!/https?:\/\//.test(code), 'outside URL found');
    expect(!/<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['"]?https?:/.test(code), 'external resource found');
  });
  await step('file: Thai only inside the th table (plus the language name and the th page title)', async () => {
    const start = code.indexOf('  th: {');
    const end = code.indexOf('const PREFS');
    expect(start > 0 && end > start, 'th table not found');
    let outside = code.slice(0, start) + code.slice(end);
    outside = outside.replaceAll('ไทย', '').replaceAll('สลับบัญชี - mockup ของ popup', '');
    const m = outside.match(/[^\n]*[฀-๿][^\n]*/);
    expect(!m, `Thai text outside the th table: ${m && m[0].trim().slice(0, 80)}`);
  });

  // ------------------------------------------------------------------ i18n table
  const main = await open();
  const { page, popup, tid } = main;

  await step('i18n: en and th have the same keys, placeholders and bold markers', async () => {
    const r = await page.evaluate(() => {
      const flat = (v) => (Array.isArray(v) ? v.join('') : v);
      const ph = (s) => [...flat(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      const bold = (s) => (flat(s).match(/\[\[/g) || []).length;
      const kEn = Object.keys(I18N.en), kTh = Object.keys(I18N.th);
      const out = [];
      for (const k of kEn) if (!(k in I18N.th)) out.push(`missing in th: ${k}`);
      for (const k of kTh) if (!(k in I18N.en)) out.push(`missing in en: ${k}`);
      for (const k of kEn) if (k in I18N.th) {
        if (ph(I18N.en[k]) !== ph(I18N.th[k]) && k !== 'n.tabs') out.push(`placeholders differ: ${k}`);
        if (bold(I18N.en[k]) !== bold(I18N.th[k])) out.push(`bold markers differ: ${k}`);
        if (Array.isArray(I18N.en[k]) !== Array.isArray(I18N.th[k]) && k !== 'n.tabs') out.push(`plural shape differs: ${k}`);
        if (!flat(I18N.th[k]).trim() || !flat(I18N.en[k]).trim()) out.push(`empty: ${k}`);
      }
      return { out, n: kEn.length };
    });
    expect(r.out.length === 0, r.out.join(' | '));
    log(`      ${r.n} keys, en = th`);
  });
  await step('i18n: English has no Thai (except the language name), Thai strings contain Thai', async () => {
    const r = await page.evaluate(() => {
      const bad = [];
      for (const [k, v] of Object.entries(I18N.en)) if (/[฀-๿]/.test([v].flat().join('')) && k !== 'settings.langTh') bad.push(`en has Thai: ${k}`);
      const allowLatin = ['lock.mockHint', 'settings.langEn', 'add.defaultName', 'sub.googleBrand', 'sub.google'];
      for (const [k, v] of Object.entries(I18N.th)) if (!/[฀-๿]/.test([v].flat().join('')) && !allowLatin.includes(k)) bad.push(`th has no Thai: ${k}`);
      return bad;
    });
    expect(r.length === 0, r.join(' | '));
  });
  await step('i18n: Auto follows the browser language (en-US -> English)', async () => {
    expect((await page.evaluate(() => document.documentElement.lang)) === 'en', 'lang is not en');
    expect((await popup.locator('.head h1').innerText()) === 'Account Switcher', 'title');
  });
  {
    const th = await open({ locale: 'th-TH' });
    await step('i18n: Auto follows the browser language (th-TH -> Thai) and sets <html lang>', async () => {
      expect((await th.page.evaluate(() => document.documentElement.lang)) === 'th', 'lang is not th');
      expect(hasThai(await th.popup.locator('.head h1').innerText()), 'title is not Thai');
    });
    await th.context.close();
  }

  // ------------------------------------------------------------------ theme: first paint + persistence
  {
    const dark = await open({ colorScheme: 'light' }, () => {
      try { localStorage.setItem('sam.theme', 'dark'); } catch {}
      const orig = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (n, v) {
        if (n === 'data-theme' && window.__themeSetWhen === undefined) window.__themeSetWhen = document.body ? 'after-body' : 'before-body';
        return orig.call(this, n, v);
      };
    });
    await step('theme: saved Dark is applied before the body exists (no light flash)', async () => {
      const when = await dark.page.evaluate(() => window.__themeSetWhen);
      expect(when === 'before-body', `theme attribute set ${when}`);
      const bg = await dark.popup.evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(bg !== 'rgb(255, 255, 255)', `bg=${bg}`);
    });
    await dark.context.close();
    problems = [];
  }

  // ------------------------------------------------------------------ main flows (run in en, then th)
  async function flows(lang) {
    const L = (s) => `[${lang}] ${s}`;
    const m = await open({ locale: lang === 'th' ? 'th-TH' : 'en-US' });
    const { page: pg, popup: pp, tid: id, waitState, idle, tx, watch } = m;
    const switchSteps = async (key, p) => tx(key, p);

    await step(L('list: Facebook shows 3 accounts, the active one is first with its badge'), async () => {
      expect((await m.state()) === 'list', `state=${await m.state()}`);
      const rows = pp.locator('[data-testid^="row-"]');
      expect((await rows.count()) === 3, 'not 3 rows');
      expect((await rows.first().getAttribute('data-id')) === 'fb1', 'first row is not the active account');
      expect((await rows.first().locator('.chip.on').innerText()).includes(await tx('chip.active')), 'no Active chip');
      expect(await id('row-fb3').locator('.chip.bad').isVisible(), 'expired account has no badge');
    });

    await step(L('empty: Instagram shows the 3 steps'), async () => {
      await id('tab-instagram').click();
      await waitState('empty');
      const t = await id('empty').innerText();
      expect(t.includes(await tx('empty.step2')) && t.includes(await tx('empty.title', { platform: 'Instagram' })), 'steps missing');
    });

    await step(L('add: not logged in -> inline warning'), async () => {
      await id('toggle-logged-in').uncheck();
      await pp.getByTestId('add-account').click();
      await id('add-not-logged-in').waitFor();
      expect((await id('add-not-logged-in').innerText()).includes('Instagram'), 'platform missing');
      await id('add-cancel').click();
      await id('toggle-logged-in').check();
    });

    await step(L('add: empty name rejected, valid name saved as the active account'), async () => {
      await pp.getByTestId('add-account').click();
      await id('add-form').waitFor();
      await id('add-input').fill('');
      await id('add-save').click();
      expect((await id('add-hint').innerText()) === (await tx('rename.bad')), 'empty name not rejected');
      await id('add-input').fill(lang === 'th' ? 'ร้านขนม IG' : 'Bakery IG');
      await id('add-input').press('Enter');
      await waitState('list');
      expect((await pp.locator('.row.active .name .nm').innerText()) === (lang === 'th' ? 'ร้านขนม IG' : 'Bakery IG'), 'new account not active');
      expect(!(await id('add-hint').count()), 'form still open');
    });

    await step(L('tab: pill glides + panel slides (animation 2)'), async () => {
      const seen = await watch(async () => { await id('tab-facebook').click(); await waitState('list'); });
      const keys = [...seen.keys()].join(' ');
      expect(keys.includes('::view-transition-group(pill)'), `no pill animation: ${keys}`);
      expect(keys.includes('::view-transition-old(panel)') && keys.includes('::view-transition-new(panel)'), `no panel slide: ${keys}`);
      expect(seen.get('::view-transition-new(panel)').kf.includes('translateX'), 'panel does not slide sideways');
    });

    await step(L('switching: spinner, step label, other controls disabled'), async () => {
      const seen = await watch(async () => { await id('row-fb2').locator('button.main').click(); await waitState('switching'); });
      expect([...seen.keys()].some((k) => k.startsWith('::view-transition-group(slot-fb2)')), `slot does not morph (animation 4): ${[...seen.keys()]}`);
      expect(await id('row-fb2').locator('.spinner').isVisible(), 'no spinner');
      expect((await id('switch-step').innerText()).length > 3, 'no step label');
      expect(await id('add-account').isDisabled(), 'add button enabled');
      expect(await id('tab-instagram').isDisabled(), 'tab enabled');
      expect(await id('settings-btn').isDisabled(), 'settings enabled');
      const spin = await pg.evaluate(() => document.querySelector('.spinner').getAnimations().length);
      expect(spin === 1, `spinner animations: ${spin}`);
    });

    await step(L('success: toast with the new name, badge moves, row shows the success badge'), async () => {
      const seen = await watch(async () => { await waitState('success'); }, 900);
      const toast = await id('toast').innerText();
      expect(toast.includes(await tx('toast.switched', { name: lang === 'th' ? 'ร้านขนมบ้านส้ม' : 'Orange Bakery' })), `toast: ${toast}`);
      expect(toast.includes(await tx('toast.reloaded', { tabs: await tx('n.tabs', { n: 2 }) })), `toast: ${toast}`);
      expect(await id('row-fb2').evaluate((e) => e.classList.contains('active')), 'fb2 not active');
      expect(await id('flash-fb2').isVisible(), 'no success badge');
      expect([...seen.entries()].some(([k, v]) => k.startsWith('::view-transition-new(toast)') && v.name === 'vt-toast-in'), 'toast does not slide in (animation 6)');
      expect([...seen.keys()].some((k) => k.startsWith('::view-transition-group(row-fb1)')), 'rows do not glide (animation 3)');
    });

    if (lang === 'en') {
      await step(L('toast slides out and leaves within 4.5 s, the badge returns to the actions'), async () => {
        const seen = await watch(async () => { await id('toast').waitFor({ state: 'detached', timeout: 5500 }); }, 5200);
        expect([...seen.entries()].some(([k, v]) => k.startsWith('::view-transition-old(toast)') && v.name === 'vt-toast-out'), 'toast does not slide out');
        await id('rename-fb2').waitFor();
      });
    } else {
      await id('toast').waitFor({ state: 'detached', timeout: 5500 }).catch(() => {});
    }

    await step(L('error: expired session -> error bar, old account still active'), async () => {
      await id('row-fb3').locator('button.main').click();
      await waitState('error');
      const t = await id('error').innerText();
      expect(t.includes(await tx('error.title', { name: lang === 'th' ? 'งานลูกค้า A' : 'Client work A' })), `error: ${t}`);
      expect(t.includes(await tx('error.update')), 'no Update session button');
      expect(await id('row-fb2').evaluate((e) => e.classList.contains('active')), 'previous account was not kept');
      expect(await id('flash-fb3').isVisible(), 'no error badge');
    });
    await step(L('error: Update session clears the Log in again badge'), async () => {
      await id('error-update').click();
      await waitState('list');
      expect((await id('row-fb3').locator('.chip.bad').count()) === 0, 'badge still there');
    });

    await step(L('rename: inline editor expands (animation 5), empty rejected, hint resets, Enter saves, Esc cancels'), async () => {
      await idle();
      const seen = await watch(async () => { await id('rename-fb2').click(); await waitState('rename'); });
      expect([...seen.keys()].some((k) => k.startsWith('::view-transition-group(row-fb2)')), 'row does not expand smoothly');
      const input = id('rename-input');
      expect(await input.evaluate((e) => e === document.activeElement), 'input not focused');
      await input.fill('   ');
      await id('rename-save').click();
      expect((await pp.locator('.row.editing .hint.bad').count()) === 1, 'empty name not rejected');
      await input.fill(lang === 'th' ? 'ร้านขนม (เพจหลัก)' : 'Bakery (main page)');
      expect((await pp.locator('.row.editing .hint.bad').count()) === 0, 'error hint stays after a valid name');
      expect((await id('rename-hint').innerText()) === (await tx('rename.hint')), 'hint text did not reset');
      await input.press('Enter');
      await waitState('list');
      expect((await id('row-fb2').locator('.name .nm').innerText()) === (lang === 'th' ? 'ร้านขนม (เพจหลัก)' : 'Bakery (main page)'), 'name not changed');
      await id('rename-fb1').click();
      await id('rename-input').fill('discard me');
      await id('rename-input').press('Escape');
      await waitState('list');
      expect((await id('row-fb1').locator('.name .nm').innerText()) === (lang === 'th' ? 'ส่วนตัว' : 'Personal'), 'Esc changed the name');
    });

    await step(L('delete: inline confirm, cancel keeps it, confirm fades it out and the rest glide (animation 3)'), async () => {
      await idle();
      await id('delete-fb3').click();
      await waitState('delete');
      expect((await id('confirm-delete').innerText()).includes(lang === 'th' ? 'งานลูกค้า A' : 'Client work A'), 'name missing');
      await id('delete-cancel').click();
      await waitState('list');
      expect((await id('row-fb3').count()) === 1, 'deleted although cancelled');
      await idle();
      await id('delete-fb3').click();
      await waitState('delete');
      await idle();
      const seen = await watch(async () => { await id('delete-confirm').click(); await waitState('list'); });
      expect((await id('row-fb3').count()) === 0, 'not deleted');
      expect((await id('tab-facebook').locator('.count').innerText()) === '2', 'count not reduced');
      expect([...seen.entries()].some(([k, v]) => k.startsWith('::view-transition-old(row-fb3)') && v.name === 'vt-fade-out'), 'removed row does not fade out');
    });

    await step(L('add: new row pops in (animation 3)'), async () => {
      await idle();
      await pp.getByTestId('add-account').click();
      await id('add-form').waitFor();
      await idle();
      const seen = await watch(async () => { await id('add-save').click(); await waitState('list'); });
      expect([...seen.entries()].some(([k, v]) => /^::view-transition-new\(row-n\d+\)/.test(k) && v.name === 'vt-pop-in'), `new row does not pop in: ${[...seen.keys()]}`);
    });

    await step(L('YouTube: Google steps + note, switch works'), async () => {
      await idle();
      await id('tab-youtube').click();
      await m.waitPlatform('youtube');
      await waitState('list');
      expect((await pp.innerText()).includes('Gmail'), 'note missing');
      await id('row-yt3').locator('button.main').click();
      expect((await id('switch-step').innerText()).includes(await tx('step.google')), 'step is not the Google one');
      await waitState('success');
      await idle();
    });

    await step(L('settings: opens with a slide, back returns, Lock now locks'), async () => {
      await id('settings-btn').click();
      await waitState('settings');
      await idle();
      await id('settings-back').click();
      await pg.waitForFunction(() => ['success', 'list'].includes(document.getElementById('popup').dataset.state));
      await idle();
      await id('settings-btn').click();
      await waitState('settings');
      await idle();
      await id('lock-now').click();
      await waitState('locked');
      await idle();
    });

    await step(L('lock: master password field (no PIN), show/hide toggles type and aria-pressed'), async () => {
      expect((await id('pw-input').getAttribute('type')) === 'password', 'not a password field');
      expect((await pp.locator('[data-pin]').count()) === 0, 'PIN field present');
      expect(!(await pp.innerText()).includes('PIN'), 'PIN mentioned');
      await id('pw-input').fill('wrong-pass-1');
      await id('pw-toggle').click();
      expect((await id('pw-input').getAttribute('type')) === 'text', 'still hidden');
      expect((await id('pw-toggle').getAttribute('aria-pressed')) === 'true', 'aria-pressed');
      expect((await id('pw-input').inputValue()) === 'wrong-pass-1', 'value lost');
      await id('pw-toggle').click();
    });

    await step(L('lock: unlock button morphs idle -> loading -> error, hint shows, typing clears it'), async () => {
      const seen = await watch(async () => {
        await id('unlock').click();
        await pg.waitForFunction(() => document.querySelector('[data-testid="unlock"]')?.dataset.btnState === 'err', null, { timeout: 4000 });
      }, 1800);
      expect([...seen.keys()].some((k) => k.startsWith('::view-transition-group(sbtn)')), `button does not morph: ${[...seen.keys()]}`);
      expect((await id('pw-hint').innerText()) === (await tx('lock.bad')), 'no wrong-password hint');
      await pg.waitForFunction(() => document.querySelector('[data-testid="unlock"]')?.dataset.btnState === 'idle', null, { timeout: 3000 });
      await id('pw-input').fill('orange-cat-2026');
      expect((await id('pw-hint').innerText()) !== (await tx('lock.bad')), 'error hint stays after typing');
    });
    await step(L('lock: right password -> loading -> success -> list'), async () => {
      await id('pw-input').press('Enter');
      await pg.waitForFunction(() => document.querySelector('[data-testid="unlock"]')?.dataset.btnState === 'ok', null, { timeout: 4000 });
      await waitState('list');
      await idle();
    });

    await step(L('forgot password: a stale wrong-password message is gone once the wipe confirm opens (QC n4)'), async () => {
      await pg.evaluate(() => { window.__mock.jump('locked-wrong'); });
      await waitState('locked'); await idle();
      expect((await id('pw-hint').innerText()) === (await tx('lock.bad')), 'wrong-password hint not shown');
      await id('forgot').click();
      await id('wipe-confirm').waitFor();
      expect(!(await pp.innerText()).includes(await tx('lock.bad')), 'stale wrong-password message still visible');
      await idle();
      await id('wipe-cancel').click();
      await id('unlock').waitFor();
      await pg.evaluate(() => { window.__mock.jump('list'); });
      await waitState('list'); await idle();
    });

    await step(L('forgot password: inline wipe confirm, buttons stay inside, cancel, then wipe keeps YouTube'), async () => {
      await id('settings-btn').click();
      await waitState('settings');
      await idle();
      await id('lock-now').click();
      await waitState('locked');
      await idle();
      await id('forgot').click();
      await id('wipe-confirm').waitFor();
      await idle();
      const spill = await id('wipe-confirm').evaluate((box) => {
        const r = box.getBoundingClientRect();
        return [...box.querySelectorAll('button')].filter((b) => { const q = b.getBoundingClientRect(); return q.left < r.left || q.right > r.right; }).length;
      });
      expect(spill === 0, `${spill} buttons outside the confirm box`);
      await id('wipe-cancel').click();
      await id('unlock').waitFor();
      await id('forgot').click();
      await id('wipe-ok').click();
      await waitState('empty');
      expect((await id('tab-facebook').locator('.count').innerText()) === '0', 'Facebook not wiped');
      expect((await id('tab-youtube').locator('.count').innerText()) === '3', 'YouTube lost');
      await idle();
    });

    await step(L('settings: theme + language saved, Circle Reveal grows from the click point (animation 1)'), async () => {
      await id('settings-btn').click();
      await waitState('settings');
      await idle();
      const btn = id('s-theme-dark');
      const box = await btn.boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const seen = await watch(async () => { await btn.click(); await pg.waitForFunction(() => document.documentElement.dataset.theme === 'dark'); }, 1400);
      const rv = seen.get('::view-transition-new(root)');
      expect(rv, `no reveal animation: ${[...seen.keys()]}`);
      const m = rv.kf.match(/circle\(0px at ([\d.]+)px ([\d.]+)px\)/);
      expect(m, `clip-path is not a circle from 0: ${rv.kf}`);
      expect(Math.abs(Number(m[1]) - cx) < 3 && Math.abs(Number(m[2]) - cy) < 3, `circle starts at ${m[1]},${m[2]} not at the click ${cx},${cy}`);
      await idle();
      expect((await pg.evaluate(() => localStorage.getItem('sam.theme'))) === 'dark', 'theme not saved');
      await id('s-theme-system').click();
      await pg.waitForFunction(() => !document.documentElement.dataset.theme);
      await idle();
      await id('s-lang-th').click();
      await pg.waitForFunction(() => document.documentElement.lang === 'th');
      await idle();
      expect((await pg.evaluate(() => localStorage.getItem('sam.lang'))) === 'th', 'language not saved');
      expect(hasThai(await pp.locator('.head h1').innerText()), 'UI did not switch to Thai');
      await id('s-lang-en').click();
      await pg.waitForFunction(() => document.documentElement.lang === 'en');
      await idle();
      await id('s-lang-auto').click();
      await idle();
    });

    await step(L('settings: Wipe all data expands a confirm, then clears every platform'), async () => {
      const seen = await watch(async () => { await id('s-wipe').click(); await id('settings-wipe-confirm').waitFor(); });
      expect([...seen.keys()].some((k) => k.startsWith('::view-transition-group(card-wipe)')), `confirm does not expand: ${[...seen.keys()]}`);
      await idle();
      await id('s-wipe-cancel').click();
      await id('s-wipe').waitFor();
      await idle();
      await id('s-wipe').click();
      await id('s-wipe-ok').click();
      await waitState('empty');
      for (const k of ['facebook', 'instagram', 'youtube']) expect((await id(`tab-${k}`).locator('.count').innerText()) === '0', `${k} not wiped`);
    });

    await step(L('no dialog / network / console error in this pass'), async () => {
      expect(problems.length === 0, problems.join(' | '));
    });
    await m.context.close();
  }
  await flows('en');
  await flows('th');
  problems = [];

  // ------------------------------------------------------------------ every state x language x theme: layout + shots
  const states = ['list', 'empty', 'add-form', 'add-not-logged-in', 'switching', 'success', 'error', 'rename', 'delete', 'youtube', 'locked', 'locked-wrong', 'wipe-confirm', 'settings', 'settings-wipe'];
  for (const lang of ['en', 'th']) {
    await step(`[${lang}] language button switches the UI`, () => main.setLang(lang));
    for (const theme of ['light', 'dark']) {
      await step(`[${lang}/${theme}] theme button switches the theme`, () => main.setTheme(theme));
      await step(`[${lang}/${theme}] theme switch recolours the popup`, async () => {
        const bg = await popup.evaluate((e) => getComputedStyle(e).backgroundColor);
        expect(theme === 'dark' ? bg !== 'rgb(255, 255, 255)' : bg === 'rgb(255, 255, 255)', `bg=${bg}`);
      });
      for (const s of states) {
        await step(`[${lang}/${theme}] ${s}: layout, text, shot`, async () => {
          await main.jump(s);
          const bad = await layoutProblems(popup);
          expect(bad.length === 0, bad.slice(0, 3).join(' | '));
          const text = await popup.innerText();
          expect(!/\{\w+\}|\[\[|\]\]/.test(text), `placeholder left in text: ${(text.match(/\{\w+\}|\[\[|\]\]/) || [''])[0]}`);
          const keyLeak = await page.evaluate((t) => Object.keys(I18N.en).find((k) => t.includes(k)), text);
          expect(!keyLeak, `message key shown: ${keyLeak}`);
          if (lang === 'en') expect(!hasThai(text.replaceAll('ไทย', '')), 'Thai text in the English UI');
          else expect(hasThai(text), 'no Thai text in the Thai UI');
          expect((await popup.evaluate((e) => e.ownerDocument.documentElement.lang)) === lang, 'html lang');
          if (writeShots) {
            await popup.screenshot({ path: join(shotsDir, `${lang}-${theme}-${s}.png`), animations: 'disabled' });
          }
        });
      }
    }
  }
  if (writeShots) log(`      shots  mockup/shots/{en,th}-{light,dark}-{${states.join(',')}}.png`);

  await step('contrast: secondary text and footer >= 4.5:1 in en/th x light/dark', async () => {
    for (const lang of ['en', 'th']) {
      await main.setLang(lang);
      for (const theme of ['light', 'dark']) {
        await main.setTheme(theme);
        await main.jump('list');
        const ratios = await page.evaluate(() => {
          const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
          const lum = ([r, g, b]) => {
            const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const bg = lum(rgb(getComputedStyle(document.getElementById('popup')).backgroundColor));
          const ratio = (sel) => {
            const a = lum(rgb(getComputedStyle(document.querySelector(sel)).color));
            return (Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05);
          };
          return { sub: ratio('.who .sub'), foot: ratio('.foot span'), label: ratio('.section-label') };
        });
        for (const [k, v] of Object.entries(ratios)) expect(v >= 4.5, `${lang}/${theme} ${k}: ${v.toFixed(2)}:1`);
        log(`      ${lang}/${theme}: sub ${ratios.sub.toFixed(2)} · foot ${ratios.foot.toFixed(2)} · label ${ratios.label.toFixed(2)}`);
      }
    }
  });

  await step('whole matrix: no dialog / network / console error', async () => {
    expect(problems.length === 0, problems.join(' | '));
  });
  await main.context.close();

  // ------------------------------------------------------------------ reduced motion
  {
    problems = [];
    const rm = await open({ reducedMotion: 'reduce' }, () => {
      window.__vtSeen = 0;
      const orig = Document.prototype.startViewTransition;
      if (orig) Document.prototype.startViewTransition = function (...a) { window.__vtSeen++; return orig.apply(this, a); };
    });
    const live = () => rm.page.evaluate(() => document.getAnimations().map((a) => `${a.constructor.name}:${a.animationName || a.transitionProperty || ''}:${a.effect?.pseudoElement || ''}`));
    await step('reduced motion: tab, switch, theme, delete, toast, settings run with no animation at all', async () => {
      const { tid, waitState, page: pg } = rm;
      await tid('tab-youtube').click(); await waitState('list');
      await tid('tab-facebook').click(); await waitState('list');
      expect((await live()).length === 0, `animations after tab: ${await live()}`);
      await tid('row-fb2').locator('button.main').click();
      await waitState('switching');
      expect((await live()).length === 0, `animations while switching (spinner must be still): ${await live()}`);
      await waitState('success', 6000);
      expect((await live()).length === 0, `animations after switch: ${await live()}`);
      await tid('settings-btn').click(); await waitState('settings');
      await tid('s-theme-dark').click();
      await pg.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      expect((await live()).length === 0, `animations after theme change: ${await live()}`);
      await tid('settings-back').click();
      await tid('delete-fb3').click(); await waitState('delete');
      await tid('delete-confirm').click(); await waitState('success').catch(() => {});
      expect((await live()).length === 0, `animations after delete: ${await live()}`);
      const seen = await pg.evaluate(() => window.__vtSeen);
      expect(seen === 0, `a view transition ran ${seen} times`);
    });
    await step('reduced motion: the state still changes (theme applied, account switched)', async () => {
      expect((await rm.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'theme');
      expect(await rm.tid('row-fb2').evaluate((e) => e.classList.contains('active')), 'account not switched');
    });
    await step('reduced motion: no console error / dialog / network', async () => { expect(problems.length === 0, problems.join(' | ')); });
    await rm.context.close();
  }

  // ------------------------------------------------------------------ no View Transitions support
  {
    problems = [];
    const nv = await open({}, () => { delete Document.prototype.startViewTransition; });
    await step('no View Transitions support: everything changes instantly and nothing throws', async () => {
      const { tid, waitState, page: pg } = nv;
      expect(!(await pg.evaluate(() => 'startViewTransition' in document)), 'API still present');
      await tid('tab-youtube').click(); await waitState('list');
      await tid('row-yt3').locator('button.main').click();
      await waitState('success', 6000);
      await tid('settings-btn').click(); await waitState('settings');
      await tid('s-theme-light').click();
      await pg.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await tid('s-lang-th').click();
      await pg.waitForFunction(() => document.documentElement.lang === 'th');
      await tid('settings-back').click();
      expect(problems.length === 0, problems.join(' | '));
    });
    await nv.context.close();
  }
} finally {
  await browser.close();
}

log(`summary: pass ${pass} - fail ${fail}`);
writeFileSync(logFile, lines.join('\n') + '\n');
process.exit(fail ? 1 : 0);
