// e2e ของ mockup/popup.html — คลิกผ่านทุกสถานะ เก็บภาพ (สว่าง+มืด) และเขียน log
// วิธีรัน + ตัวแปรที่ต้องตั้ง: ดู mockup/README.md
// ผล:   mockup/shots/*.png  ·  mockup/e2e/e2e.log  ·  exit 1 ถ้ามีข้อใดล้ม
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mockupDir = resolve(here, '..');
const shotsDir = join(mockupDir, 'shots');
const logFile = join(here, 'e2e.log');
const htmlPath = join(mockupDir, 'popup.html');
const repoRoot = resolve(mockupDir, '..');
const rel = (p) => relative(repoRoot, p);
mkdirSync(shotsDir, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.error('หา playwright ไม่เจอ — ตั้ง PLAYWRIGHT_MODULE=<path>/node_modules/playwright');
  process.exit(2);
}

const lines = [];
const t0 = Date.now();
const log = (s) => {
  const line = `[${String(Date.now() - t0).padStart(5)}ms] ${s}`;
  lines.push(line);
  console.log(line);
};
let pass = 0;
let fail = 0;
const problems = [];

async function step(name, fn) {
  try {
    await fn();
    pass++;
    log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    log(`FAIL  ${name} — ${String(e.message || e).split('\n')[0]}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 760, height: 720 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();

  // ด่านนโยบาย: ไม่มี dialog, ไม่มี request ออกเน็ต, ไม่มี error ใน console
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
  const state = () => popup.getAttribute('data-state');
  const waitState = (s, timeout = 4000) =>
    page.waitForFunction((v) => document.getElementById('popup').dataset.state === v, s, { timeout });
  const shot = async (name) => {
    await popup.screenshot({ path: join(shotsDir, `${name}.png`), animations: 'disabled' });
    log(`      shot  mockup/shots/${name}.png`);
  };
  const tid = (id) => page.getByTestId(id);

  log(`เปิด ${rel(htmlPath)} · browser ${browser.version()}`);

  await step('popup กว้าง 360px และไม่มีอะไรล้นออกนอก popup', async () => {
    const box = await popup.boundingBox();
    expect(Math.round(box.width) === 360, `กว้าง ${box.width}`);
    const over = await popup.evaluate((p) => {
      const r = p.getBoundingClientRect();
      return [...p.querySelectorAll('.tab, .tab *')].filter((e) => e.getBoundingClientRect().right > r.right - 12 + 0.5).length;
    });
    expect(over === 0, `มี ${over} element ของแถบแท็บล้นขอบ`);
  });

  await step('ไฟล์ไม่เรียก chrome.* API และไม่มี alert/confirm/prompt', async () => {
    const src = readFileSync(htmlPath, 'utf8');
    const script = src.slice(src.indexOf('<script>'));
    expect(!/\bchrome\.[a-z]/.test(script), 'พบ chrome.*');
    expect(!/\b(alert|confirm|prompt)\s*\(/.test(script), 'พบ alert/confirm/prompt');
    expect(!/https?:\/\//.test(src.replace(/<!--[\s\S]*?-->/g, '')), 'พบ URL ภายนอกในไฟล์');
  });

  // ---------- สถานะ: มีบัญชีหลายรายการ ----------
  await step('มีบัญชี: FB แสดง 3 บัญชี + บัญชีที่ใช้อยู่อยู่บนสุดพร้อมป้าย', async () => {
    expect((await state()) === 'list', `state=${await state()}`);
    const rows = popup.locator('[data-testid^="row-"]');
    expect((await rows.count()) === 3, 'ไม่ใช่ 3 แถว');
    const first = rows.first();
    expect((await first.getAttribute('data-id')) === 'fb1', 'แถวแรกไม่ใช่บัญชีที่ใช้อยู่');
    expect((await first.locator('.chip.on').innerText()).includes('ใช้อยู่'), 'ไม่มีป้ายใช้อยู่');
    expect(await tid('row-fb3').locator('.chip.bad').isVisible(), 'บัญชีหมดอายุไม่มีป้าย');
    await shot('01-list');
  });

  const noTruncation = async (where) => {
    const cut = await popup.evaluate((p) =>
      [...p.querySelectorAll('.who .sub, .who .name .nm')]
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent.trim()),
    );
    expect(cut.length === 0, `${where}: ข้อความถูกตัด → ${cut.join(' | ')}`);
  };
  await step('ข้อความชื่อ/ข้อความรองของทุกแถวไม่ถูกตัด (FB, YouTube)', async () => {
    await noTruncation('Facebook');
    await tid('tab-youtube').click();
    await waitState('list');
    await noTruncation('YouTube');
    await tid('tab-facebook').click();
    await waitState('list');
  });

  // ---------- สถานะ: ว่าง ----------
  await step('ว่าง: แท็บ Instagram แสดงคำแนะนำ login ก่อนแล้วกดเพิ่ม', async () => {
    await tid('tab-instagram').click();
    await waitState('empty');
    const t = await tid('empty').innerText();
    expect(t.includes('login') && t.includes('เพิ่มบัญชี'), 'ไม่มีคำแนะนำ');
    await shot('02-empty');
  });

  await step('เพิ่มบัญชี (ไม่ได้ login): แสดงคำเตือน inline', async () => {
    await tid('toggle-logged-in').uncheck();
    await popup.getByTestId('add-account').click();
    await tid('add-not-logged-in').waitFor();
    await shot('03-add-not-logged-in');
    await tid('add-cancel').click();
    await tid('toggle-logged-in').check();
  });

  await step('เพิ่มบัญชี: ฟอร์มตั้งชื่อ → บันทึก → กลายเป็นบัญชีที่ใช้อยู่', async () => {
    await popup.getByTestId('add-account').click();
    await tid('add-form').waitFor();
    await tid('add-input').fill('');
    await tid('add-save').click();
    expect((await tid('add-form').innerText()).includes('อย่างน้อย 1 ตัวอักษร'), 'ไม่ตรวจชื่อว่าง');
    await tid('add-input').fill('ร้านขนม IG');
    await shot('04-add-form');
    await tid('add-input').press('Enter');
    await waitState('list');
    expect((await popup.locator('.row.active .name .nm').innerText()) === 'ร้านขนม IG', 'บัญชีใหม่ไม่ active');
  });

  // ---------- สถานะ: กำลังสลับ → สำเร็จ ----------
  await step('กำลังสลับ: แถวเป้าหมายมี spinner + ขั้นตอน + ปุ่มอื่นถูกปิด', async () => {
    await tid('tab-facebook').click();
    await waitState('list');
    await tid('row-fb2').locator('button.main').click();
    expect((await state()) === 'switching', `state=${await state()}`);
    expect(await tid('row-fb2').locator('.spinner').isVisible(), 'ไม่มี spinner');
    expect(await tid('add-account').isDisabled(), 'ปุ่มเพิ่มยังกดได้');
    expect(await tid('tab-instagram').isDisabled(), 'แท็บยังกดได้');
    await shot('05-switching');
  });

  await step('สำเร็จ: toast แสดงชื่อบัญชีใหม่ + ป้ายใช้อยู่ย้ายแถว', async () => {
    await waitState('success');
    const t = await tid('toast').innerText();
    expect(t.includes('ร้านขนมบ้านส้ม') && t.includes('รีโหลด'), `toast: ${t}`);
    expect(await tid('row-fb2').evaluate((e) => e.classList.contains('active')), 'fb2 ไม่ active');
    await shot('06-success');
  });

  await step('toast หายเองภายใน 4.5 วินาที', async () => {
    await tid('toast').waitFor({ state: 'detached', timeout: 4500 });
  });

  // ---------- สถานะ: error ----------
  await step('error: สลับไปบัญชีที่ session หมดอายุ → แถบ error + บัญชีเดิมยังใช้อยู่', async () => {
    await tid('row-fb3').locator('button.main').click();
    await waitState('error');
    const t = await tid('error').innerText();
    expect(t.includes('หมดอายุ') && t.includes('อัปเดต session'), `error: ${t}`);
    expect(await tid('row-fb2').evaluate((e) => e.classList.contains('active')), 'บัญชีเดิมไม่ได้ถูกใส่กลับ');
    await shot('07-error');
  });

  await step('error: กด "อัปเดต session" → ป้ายต้อง login ใหม่หายไป', async () => {
    await tid('error-update').click();
    await waitState('list');
    expect((await tid('row-fb3').locator('.chip.bad').count()) === 0, 'ป้ายยังอยู่');
  });

  // ---------- สถานะ: เปลี่ยนชื่อ ----------
  await step('เปลี่ยนชื่อ: ช่องพิมพ์ inline, ชื่อว่างถูกปฏิเสธ, Enter บันทึก', async () => {
    await tid('rename-fb2').click();
    await waitState('rename');
    const input = tid('rename-input');
    expect(await input.evaluate((e) => e === document.activeElement), 'ช่องไม่ได้ focus');
    await input.fill('   ');
    await tid('rename-save').click();
    expect((await popup.locator('.row.editing .hint.bad').count()) === 1, 'ไม่ตรวจชื่อว่าง');
    await input.fill('ร้านขนม (เพจหลัก)');
    expect((await popup.locator('.row.editing .hint.bad').count()) === 0, 'ข้อความ error ค้างหลังพิมพ์ชื่อที่ถูก');
    await shot('08-rename');
    await input.press('Enter');
    await waitState('list');
    expect((await tid('row-fb2').locator('.name .nm').innerText()) === 'ร้านขนม (เพจหลัก)', 'ชื่อไม่เปลี่ยน');
    expect((await tid('row-fb2').locator('.avatar').innerText()).trim().startsWith('ร'), 'ตัวอักษรย่อไทยผิด');
  });

  await step('เปลี่ยนชื่อ: Esc ยกเลิกไม่เปลี่ยนชื่อ', async () => {
    await tid('rename-fb1').click();
    await tid('rename-input').fill('ไม่ควรถูกบันทึก');
    await tid('rename-input').press('Escape');
    await waitState('list');
    expect((await tid('row-fb1').locator('.name .nm').innerText()) === 'ส่วนตัว', 'ชื่อถูกเปลี่ยน');
  });

  // ---------- สถานะ: ยืนยันลบ inline ----------
  await step('ยืนยันลบ: กล่องยืนยันในแถว (ไม่ใช่ dialog) → ยกเลิกแล้วยังอยู่', async () => {
    await tid('delete-fb3').click();
    await waitState('delete');
    expect((await tid('confirm-delete').innerText()).includes('งานลูกค้า A'), 'ไม่มีชื่อบัญชี');
    await shot('09-delete-confirm');
    await tid('delete-cancel').click();
    await waitState('list');
    expect((await tid('row-fb3').count()) === 1, 'ถูกลบทั้งที่ยกเลิก');
  });

  await step('ยืนยันลบ: กดลบ → แถวหายไป, จำนวนในแท็บลดลง', async () => {
    await tid('delete-fb3').click();
    await tid('delete-confirm').click();
    await waitState('list');
    expect((await tid('row-fb3').count()) === 0, 'ยังไม่ถูกลบ');
    expect((await tid('tab-facebook').locator('.count').innerText()) === '2', 'จำนวนไม่ลด');
  });

  // ---------- YouTube ----------
  await step('YouTube: สลับผ่าน Google multi-login + มีคำอธิบายว่าไม่กระทบ Gmail', async () => {
    await tid('tab-youtube').click();
    await waitState('list');
    expect((await popup.innerText()).includes('Gmail'), 'ไม่มีคำอธิบาย');
    await tid('row-yt3').locator('button.main').click();
    expect((await tid('switch-step').innerText()).includes('บัญชี Google'), 'ขั้นตอนไม่ใช่ของ Google');
    await waitState('success');
    await shot('10-youtube-success');
  });

  // ---------- ล็อก ----------
  await step('ล็อก: ช่องรหัสผ่านหลัก (ไม่ใช่ PIN) + footer ไม่พูดถึง PIN', async () => {
    await tid('lock-btn').click();
    await waitState('locked');
    expect((await tid('pw-input').getAttribute('type')) === 'password', 'ช่องไม่ใช่ type=password');
    expect((await popup.locator('[data-pin]').count()) === 0, 'ยังมีช่อง PIN');
    expect(!(await popup.innerText()).includes('PIN'), 'ยังมีคำว่า PIN ใน popup');
    expect((await popup.locator('.foot').innerText()).includes('รหัสผ่านหลัก'), 'footer ไม่บอกรหัสผ่านหลัก');
  });

  await step('ล็อก: ปุ่มแสดง/ซ่อนรหัสผ่านสลับ type และ aria-pressed', async () => {
    await tid('pw-input').fill('wrong-pass-1');
    await tid('pw-toggle').click();
    expect((await tid('pw-input').getAttribute('type')) === 'text', 'กดแสดงแล้วยังซ่อน');
    expect((await tid('pw-toggle').getAttribute('aria-pressed')) === 'true', 'aria-pressed ไม่เปลี่ยน');
    expect((await tid('pw-input').inputValue()) === 'wrong-pass-1', 'ค่าหายหลังกดแสดง');
    await tid('pw-toggle').click();
    expect((await tid('pw-input').getAttribute('type')) === 'password', 'กดซ่อนแล้วยังแสดง');
  });

  await step('ล็อก: รหัสผิดแสดง error inline, พิมพ์ใหม่ error หาย, รหัสถูก + Enter ปลดล็อก', async () => {
    await tid('unlock').click();
    expect((await tid('pw-hint').innerText()).includes('ไม่ถูกต้อง'), 'ไม่แจ้งรหัสผิด');
    await shot('11-locked-wrong');
    await tid('pw-input').fill('orange-cat-2026');
    expect(!(await tid('pw-hint').innerText()).includes('ไม่ถูกต้อง'), 'error ค้างหลังพิมพ์ใหม่');
    await tid('pw-input').press('Enter');
    await waitState('list');
  });

  await step('ลืมรหัสผ่าน: ยืนยัน inline → ยกเลิกได้ → ล้างข้อมูลแล้ว FB/IG ว่าง YouTube ยังอยู่', async () => {
    await tid('lock-btn').click();
    await waitState('locked');
    await tid('forgot').click();
    await tid('wipe-confirm').waitFor();
    expect((await tid('wipe-confirm').innerText()).includes('กู้รหัสผ่านไม่ได้'), 'ไม่อธิบายผล');
    const spill = await tid('wipe-confirm').evaluate((box) => {
      const r = box.getBoundingClientRect();
      return [...box.querySelectorAll('button')].filter((b) => {
        const q = b.getBoundingClientRect();
        return q.left < r.left || q.right > r.right;
      }).length;
    });
    expect(spill === 0, `ปุ่ม ${spill} ปุ่มล้นกล่องยืนยัน`);
    await shot('12-forgot-wipe-confirm');
    await tid('wipe-cancel').click();
    expect((await tid('unlock').count()) === 1, 'ยกเลิกแล้วไม่กลับหน้าปลดล็อก');
    await tid('forgot').click();
    await tid('wipe-ok').click();
    await waitState('empty');
    expect((await tid('tab-facebook').locator('.count').innerText()) === '0', 'FB ไม่ถูกล้าง');
    expect((await tid('tab-youtube').locator('.count').innerText()) === '3', 'YouTube หาย');
  });

  // ---------- ทุกสถานะผ่านปุ่มกระโดด + ภาพโหมดมืด ----------
  const jumps = [
    ['empty', 'empty'],
    ['list', 'list'],
    ['switching', 'switching'],
    ['success', 'success'],
    ['error', 'error'],
    ['rename', 'rename'],
    ['delete', 'delete'],
    ['locked', 'locked'],
  ];
  for (const theme of ['light', 'dark']) {
    await step(`ธีม ${theme}: พื้นหลัง popup เปลี่ยนตาม`, async () => {
      await tid(`theme-${theme}`).click();
      const bg = await popup.evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(theme === 'dark' ? bg !== 'rgb(255, 255, 255)' : bg === 'rgb(255, 255, 255)', `bg=${bg}`);
    });
    for (const [btn, st] of jumps) {
      await step(`[${theme}] ปุ่มกระโดด "${btn}" → state=${st}`, async () => {
        await tid(`demo-${btn}`).click();
        await waitState(st);
        await page.waitForTimeout(st === 'success' ? 250 : 120);
        await shot(`${theme}-${st}`);
      });
    }
  }

  await step('ตั้งธีม "ตามระบบ" + ระบบเป็นมืด → popup เป็นมืด', async () => {
    await tid('theme-auto').click();
    await page.emulateMedia({ colorScheme: 'dark' });
    const bg = await popup.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg !== 'rgb(255, 255, 255)', `bg=${bg}`);
  });

  await step('คอนทราสต์ข้อความหลักกับพื้น ≥ 4.5:1 ทั้งสองธีม', async () => {
    for (const theme of ['light', 'dark']) {
      await tid(`theme-${theme}`).click();
      await tid('demo-list').click();
      await noTruncation(`list ${theme}`);
      const ratio = await page.evaluate(() => {
        const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => {
          const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const p = document.getElementById('popup');
        const sub = p.querySelector('.who .sub');
        const a = lum(rgb(getComputedStyle(sub).color));
        const b = lum(rgb(getComputedStyle(p).backgroundColor));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio >= 4.5, `${theme}: ข้อความรอง ${ratio.toFixed(2)}:1`);
      log(`      ${theme}: ข้อความรอง/พื้น = ${ratio.toFixed(2)}:1`);
    }
  });

  await step('ตลอดการทดสอบ: ไม่มี dialog / network / console error', async () => {
    expect(problems.length === 0, problems.join(' | '));
  });

  await context.close();
} finally {
  await browser.close();
}

log(`สรุป: ผ่าน ${pass} · ล้ม ${fail}`);
writeFileSync(logFile, lines.join('\n') + '\n');
process.exit(fail ? 1 : 0);
