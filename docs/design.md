# สเปก: Chrome Extension สลับบัญชี Facebook / Instagram / YouTube

> สถานะ: ออกแบบ (การ์ด t-504) · ยังไม่มีโค้ด extension จริง
> mockup ที่คลิกได้: `mockup/popup.html` · ภาพทุกสถานะ: `mockup/shots/` · e2e: `mockup/e2e/` (วิธีรัน + ตัวแปรที่ต้องตั้ง: `mockup/README.md`)

**สรุป 30 วินาที**
- FB / IG: สลับด้วยการ swap ชุด cookie ของ session (ไม่แตะ cookie ของเครื่อง) เก็บในเครื่องแบบเข้ารหัสด้วยรหัสผ่านหลัก (≥ 10 ตัวอักษร)
- YouTube: **ไม่ swap cookie** ใช้ระบบหลายบัญชีของ Google (`authuser` / `pageid`) เพราะ cookie อยู่บน google.com ถ้า swap ไป Gmail ก็เปลี่ยนบัญชีตาม
- permission: `cookies`, `storage`, `scripting` + host 3 domain (ไม่ขอ google.com) · ไม่มี server ไม่ส่งข้อมูลออก ไม่เก็บรหัสผ่าน
- สร้างจริง: Bun + Vite + TypeScript strict, Biome, `bun test` + Playwright, GitHub Actions, zip สำหรับ Web Store, dependency ล่าสุดทุกตัว — แบ่งเป็น 7 การ์ด (ข้อ 8.4)

---

## 1. เป้าหมาย + ขอบเขต

**เป้าหมาย:** คนที่มีหลายบัญชีบน Facebook, Instagram หรือ YouTube สลับบัญชีได้ในคลิกเดียวจาก popup ไม่ต้อง logout แล้ว login ใหม่ ข้อมูลทั้งหมดอยู่ในเครื่องผู้ใช้

| ทำ (v1) | ไม่ทำ |
|---|---|
| 3 แพลตฟอร์ม: Facebook, Instagram, YouTube แยกแท็บละรายการ | แพลตฟอร์มอื่น (TikTok, X, Messenger.com, Threads) |
| ผู้ใช้ login เองด้วยมือ แล้วกด "เพิ่มบัญชีนี้" | **เก็บรหัสผ่าน / กรอก login อัตโนมัติ / ผ่าน 2FA ให้** |
| สลับ, เปลี่ยนชื่อ, ลบ, อัปเดต session ที่หมดอายุ | ดึงรูปโปรไฟล์ / ชื่อจริงจากแพลตฟอร์ม (ใช้ชื่อที่ผู้ใช้ตั้ง + ตัวอักษรย่อ) |
| ล็อกข้อมูลด้วยรหัสผ่านหลัก (เข้ารหัส WebCrypto) | server, sync ข้ามเครื่อง, analytics, ส่งข้อมูลออกนอกเครื่อง |
| UI ภาษาไทย popup กว้าง 360px โหมดสว่าง/มืด | เปิดหลายบัญชีพร้อมกันในหลายแท็บ (นั่นคือ Chrome Profile ไม่ใช่งานนี้) |
| Manifest V3 | export/import ข้อมูล (ไว้คิดในรุ่นถัดไป เพราะเท่ากับย้ายรหัสผ่าน) |

**ข้อสังเกตเรื่องขอบเขต:** "ทั้งเบราว์เซอร์ใช้ได้ทีละบัญชีต่อแพลตฟอร์ม" เพราะ cookie เป็นของทั้งโปรไฟล์ Chrome สลับแล้วทุกแท็บของแพลตฟอร์มนั้นเปลี่ยนตาม (ระบบจะรีโหลดให้)

---

## 2. User flow

### 2.1 เพิ่มบัญชี
1. ผู้ใช้เปิด facebook.com / instagram.com / youtube.com แล้ว login เองตามปกติ (รวม 2FA)
2. เปิด popup → อยู่แท็บแพลตฟอร์มนั้น → กด **"+ เพิ่มบัญชีที่ login อยู่ตอนนี้"**
3. extension ตรวจว่ามี session จริง (FB: `c_user`, IG: `ds_user_id`, YT: อ่าน session index ของ Google) ถ้าบัญชีนี้มีอยู่แล้วในรายการ → บอกว่า "มีแล้ว" แล้วเสนอ **อัปเดต session** แทน
4. ช่องตั้งชื่อขึ้นมาแบบ inline (ค่าเริ่มต้น เช่น "Facebook 3") → กดบันทึก
5. ครั้งแรกที่บันทึก FB/IG จะให้ตั้งรหัสผ่านหลัก (ดูข้อ 6) แล้วบัญชีนี้กลายเป็น "ใช้อยู่"

### 2.2 สลับบัญชี
1. เปิด popup → เลือกแพลตฟอร์ม → กดแถวบัญชีเป้าหมาย
2. ถ้าล็อกอยู่ (FB/IG) → ใส่รหัสผ่านหลักก่อน
3. แถวนั้นแสดง "กำลังสลับ…" เป็นขั้น (เก็บ session เดิม → ใส่ session ใหม่ → รีโหลด N แท็บ) ปุ่มอื่นของแพลตฟอร์มนั้นถูกปิดไว้กันกดซ้ำ
4. สำเร็จ → toast "สลับเป็น ‘…’ แล้ว · รีโหลด N แท็บ" และป้าย "ใช้อยู่" ย้ายไปแถวใหม่
5. ล้มเหลว → แถบ error ค้างไว้ พร้อมทางแก้ (ดู 2.5)

### 2.3 เปลี่ยนชื่อ
กดไอคอนดินสอ → ชื่อกลายเป็นช่องพิมพ์ในแถวเดิม → Enter/บันทึก หรือ Esc/ยกเลิก (ชื่อว่างไม่ได้, ยาวสุด 40 ตัวอักษร) เปลี่ยนแค่ชื่อในเครื่อง ไม่แตะแพลตฟอร์ม

### 2.4 ลบ
กดไอคอนถังขยะ → แถวกลายเป็นกล่องยืนยันสีแดง **ในหน้า popup** ("ลบ ‘…’ ? session ที่เก็บไว้จะหายไป บัญชีบนแพลตฟอร์มไม่ถูกลบ") → [ยกเลิก] [ลบ]
**ห้ามใช้ `alert/confirm` ของ browser** · ลบบัญชีที่ "ใช้อยู่" ได้ แค่ลบสำเนาในเครื่อง ไม่ logout ผู้ใช้

### 2.5 กรณียังไม่ login / session ใช้ไม่ได้
- **ยังไม่มีบัญชีเลย:** หน้าว่างพร้อมขั้นตอน 3 ข้อ (เปิดเว็บ → login เอง → กดเพิ่ม) และปุ่ม "เปิด facebook.com"
- **กดเพิ่มแต่ไม่ได้ login อยู่:** ข้อความ inline "ยังไม่พบการ login ใน Facebook — login ในแท็บก่อนแล้วกดอีกครั้ง"
- **สลับแล้ว session หมดอายุ / ถูก logout ฝั่ง server:** แถบ error "session ของ ‘…’ หมดอายุ" + ปุ่ม [เปิดหน้า login] [อัปเดต session] — ผู้ใช้ login บัญชีนั้นใหม่ด้วยมือ แล้วกด "อัปเดต session" เพื่อเก็บชุดใหม่ทับ แถวนั้นติดป้าย "ต้อง login ใหม่" จนกว่าจะอัปเดต
- **session ปัจจุบันยังไม่ได้บันทึก:** ก่อนสลับเตือน inline "บัญชีที่ใช้อยู่ตอนนี้ยังไม่ได้บันทึก ถ้าสลับจะหลุด login" → [บันทึกก่อน] [สลับเลย]

---

## 3. กลไกสลับ (แยกทีละแพลตฟอร์ม)

### 3.0 แกนกลางที่ FB และ IG ใช้ร่วมกัน (swap ชุด cookie)

```
switch(platform, targetId):
  0. ล็อกแพลตฟอร์มนี้ (กันกดซ้ำ) + เขียน journal { from, to, backup } ลง storage.session
  1. snapshot = cookies.getAll({ domain }) → กรองเอาเฉพาะ "cookie ของ session" (ไม่เอา cookie ของเครื่อง)
     ถ้า snapshot เป็นของบัญชีที่มีในรายการ → เข้ารหัสแล้วเก็บทับของเดิม (session ล่าสุดเสมอ)
  2. ลบ cookie ของ session ทั้งหมดของ domain นั้น (cookies.remove ทีละตัว ใช้ url ที่สร้างจาก secure+domain+path)
  3. ถอดรหัส cookie ของบัญชีเป้าหมาย → cookies.set ทีละตัว
     (host-only cookie ห้ามใส่ field domain; ตัวที่ expirationDate ผ่านไปแล้วข้ามไป)
  4. tabs.query({ url: host pattern }) → tabs.reload ทุกแท็บ
  5. ตรวจผล: รอแท็บแรกโหลดเสร็จ แล้วอ่าน cookie ระบุตัวตนอีกครั้ง
     ตรง targetId → สำเร็จ · หายไป/เป็นคนอื่น → ติดป้าย expired + แจ้ง error
  6. ลบ journal, ปลดล็อก
  ถ้า service worker ตายกลางทาง (MV3 ปิดตัวเองได้) → ตอนตื่นถ้าเจอ journal ค้าง ให้ใส่ backup กลับ
```

**ทำไมไม่ swap cookie ของเครื่อง (device cookie):** แพลตฟอร์มใช้ cookie อย่าง `datr`, `mid` จำว่า "เครื่องนี้เคยเห็นแล้ว" ถ้าเปลี่ยนทุกครั้งที่สลับ จะดูเหมือน login จากเครื่องใหม่ตลอด และโดน checkpoint บ่อยขึ้น จึงใช้แบบ **"เก็บทุกตัวยกเว้นรายการ device cookie"** (denylist) แทนการระบุชื่อ cookie session ตรงๆ เพราะชื่อ cookie session เปลี่ยนได้โดยไม่บอก แต่ device cookie นิ่งกว่า

**ไม่มีการเรียกเน็ตเอง:** การตรวจผลดูจาก cookie หลังแท็บรีโหลดเท่านั้น extension ไม่ยิง request ไปแพลตฟอร์มเอง

### 3.1 Facebook

| เรื่อง | รายละเอียด |
|---|---|
| domain | `.facebook.com` (รวม `www.`, `web.`, `m.`) — host pattern `*://*.facebook.com/*` |
| cookie ระบุตัวตน | `c_user` = user ID (ใช้จับคู่บัญชี) |
| cookie session สำคัญ | `c_user`, `xs` (ตัวหลัก, httpOnly), `fr`, `presence`, `spin`, `usida` ฯลฯ — เก็บทุกตัวที่ไม่อยู่ใน denylist |
| device cookie (ไม่ swap) | `datr`, `sb`, `locale`, `wd`, `dpr` |
| ระบบสลับในตัว | มี "สลับโปรไฟล์" สำหรับเพจ/โปรไฟล์ที่ผูกกับบัญชีเดียวกัน (กรณีนี้ **ไม่ต้องใช้ extension**) และ "บัญชีที่จำไว้" ในหน้า login แต่บัญชีแยกกันมักต้องใส่รหัสผ่านใหม่และต้อง logout ก่อน |
| ทำไม extension ยังมีประโยชน์ | สลับบัญชีส่วนตัวที่ **แยกกันจริง** ได้คลิกเดียว ไม่ต้อง logout (logout ฝั่ง FB = ทำลาย session ที่เก็บไว้ด้วย) ไม่ต้องพิมพ์รหัสผ่าน/2FA ซ้ำ |

ข้อควรระวัง FB: messenger.com ใช้ cookie แยก (นอกขอบเขต — เปิดค้างไว้จะยังเป็นบัญชีเดิม) · ห้ามกด "ออกจากระบบ" บนเว็บ FB ถ้าอยากเก็บ session ไว้ใช้ต่อ (บอกในหน้าว่าง + tooltip)

### 3.2 Instagram

| เรื่อง | รายละเอียด |
|---|---|
| domain | `.instagram.com` — host pattern `*://*.instagram.com/*` |
| cookie ระบุตัวตน | `ds_user_id` = user ID |
| cookie session สำคัญ | `sessionid` (ตัวหลัก, httpOnly), `ds_user_id`, `csrftoken`, `rur`, `shbid`, `shbts` |
| device cookie (ไม่ swap) | `mid`, `ig_did`, `ig_nrcb`, `datr` |
| ระบบสลับในตัว | เว็บ IG มี "สลับบัญชี" และเพิ่มได้หลายบัญชี; บัญชีที่ผูกใน Accounts Center สลับได้โดยไม่ใส่รหัสผ่าน แต่บัญชีที่ไม่ได้ผูก มักต้อง login ใหม่ และการจำบัญชีบนเว็บหลุดบ่อยกว่าในแอป |
| ทำไม extension ยังมีประโยชน์ | สลับบัญชีที่ **ไม่อยากผูก Accounts Center** (เช่น บัญชีลูกค้า แยกตัวตนกัน) ได้คลิกเดียว และใช้ UI เดียวกับ FB/YT |

ข้อควรระวัง IG: เปลี่ยน `csrftoken` ไม่ตรงกับ `sessionid` = request แรกพัง จึงต้อง swap คู่กันเสมอ (ซึ่ง denylist ทำให้อยู่แล้ว)

### 3.3 YouTube — **เลือก: ใช้ Google multi-login ไม่ swap cookie**

**ปัญหาของการ swap cookie บน YouTube:** login YouTube = login Google cookie หลัก (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `__Secure-1PSIDTS`…) อยู่บน **`.google.com`** และ `accounts.google.com` (`LSID`, `__Host-GAPS`) แล้ว YouTube ได้สำเนาบน `.youtube.com` อีกชุด (รวม `LOGIN_INFO`)

| | A) swap cookie แบบ FB/IG | **B) Google multi-login (เลือก)** |
|---|---|---|
| permission | ต้องขอ `*.google.com` + `*.youtube.com` (+ `accounts.google.com`) | แค่ `*.youtube.com` |
| กระทบบริการอื่น | **ใช่** — Gmail, Drive, Calendar, Meet ที่เปิดอยู่จะเปลี่ยนบัญชีหรือหลุด login ทั้งหมด | ไม่กระทบ — Google เป็นคนจัดการ ทุกบัญชี login พร้อมกันอยู่แล้ว |
| ความเสถียร | ต่ำ — Chrome ผูก session Google กับเครื่อง (Device Bound Session Credentials / `__Secure-1PSIDTS` หมุนเปลี่ยนตลอด) cookie ที่เก็บไว้เก่าเร็ว และ Google ตรวจจับ cookie ที่ถูกนำกลับมาใช้แล้วสั่ง login ใหม่ | สูง — เป็นฟีเจอร์ทางการของ Google |
| ความเสี่ยงความปลอดภัย | เก็บ cookie ของ **ทั้งบัญชี Google** (เท่ากับรหัสผ่าน Gmail) ในเครื่อง | ไม่เก็บ secret ใดๆ ของ Google เลย |
| ข้อจำกัด | — | ทุกบัญชีต้อง login ค้างไว้ในชุดเดียวกัน (สูงสุด ~10 บัญชี) · บัญชีลำดับแรก (authuser=0) ยังเป็นค่าเริ่มต้นของบริการ Google อื่น |

**เหตุผลที่เลือก B:** ถ้าใช้ A การสลับช่อง YouTube จะไปเปลี่ยนบัญชี Gmail ที่ทำงานอยู่ด้วย ซึ่งผู้ใช้ไม่ได้คาดไว้และอันตราย ต้องขอสิทธิ์ cookie ของ google.com ทั้งหมด (สิทธิ์ใหญ่สุดที่ขอได้) และพังง่ายเพราะ DBSC ส่วน B ได้ผลแบบเดียวกันในคลิกเดียว โดยไม่ต้องถือ secret และขอสิทธิ์น้อยกว่า

**กลไก B:**
- **เพิ่ม:** ผู้ใช้เลือกบัญชี/ช่องที่ต้องการบน YouTube เอง (เมนูรูปโปรไฟล์ → สลับบัญชี) → กด "เพิ่มบัญชีนี้" → extension อ่าน `ytcfg` ของหน้า (`SESSION_INDEX` = authuser, `DELEGATED_SESSION_ID` = pageid ของ Brand Account/ช่อง) ผ่าน `scripting.executeScript({ world: 'MAIN' })` บนแท็บ youtube.com ที่เปิดอยู่ แล้วเก็บแค่ตัวเลข 2 ตัวนี้ + ชื่อที่ผู้ใช้ตั้ง
- **สลับ:** สั่งแท็บ YouTube ที่ active (หรือเปิดใหม่ถ้าไม่มี) ไปที่
  `https://www.youtube.com/signin?action_handle_signin=true&authuser=<N>&pageid=<P>&next=<path เดิม>`
  (บัญชีส่วนตัวไม่มี pageid ก็ตัดออก) แล้วรีโหลดแท็บ YouTube อื่น
- **ตรวจผล:** อ่าน `ytcfg` อีกครั้งหลังโหลดเสร็จ ถ้า authuser/pageid ไม่ตรง = บัญชีนั้นหลุดจาก Google แล้ว → error "บัญชี Google ลำดับที่ N ไม่ได้ login อยู่ — เพิ่มบัญชีใน Google ก่อน"
- **กรณีขอบ:** ผู้ใช้ logout บัญชี Google ตัวหนึ่ง → ลำดับ authuser ของบัญชีที่เหลือ **เลื่อน** จึงต้องเก็บ "อีเมลที่ปิดบางส่วน" ไม่ได้ (ไม่ดึงข้อมูลส่วนตัว) — ใช้วิธีตรวจผลหลังสลับ ถ้าไม่ตรงให้ผู้ใช้กด "อัปเดต" ใหม่ · รูปแบบ URL `signin?…pageid` ต้องยืนยันอีกครั้งตอนสร้างจริง (เทสต์ข้อ 19 ใน 8.3)

### 3.4 กรณีขอบ (ใช้กับทุกแพลตฟอร์มที่ swap cookie)

| กรณี | อาการ | การจัดการ |
|---|---|---|
| session หมดอายุ | cookie ที่เก็บไว้ `expirationDate` ผ่านไปแล้ว หรือแพลตฟอร์มลบ cookie ทิ้งตอนโหลด | ก่อนสลับเช็ค expiry ถ้าหมดแล้วไม่ต้องลอง แจ้ง error ทันที · หลังโหลดเช็คผล (ขั้น 5) |
| ถูก logout ฝั่ง server | เปลี่ยนรหัสผ่าน, "ออกจากระบบทุกอุปกรณ์", กด logout บนเว็บ | cookie ใส่ได้แต่ server ไม่รับ → ขั้น 5 จับได้ → ติด "ต้อง login ใหม่" + ใส่ backup ของบัญชีเดิมกลับให้ ผู้ใช้ไม่หลุดทั้งคู่ |
| 2FA / checkpoint | หลังสลับ แพลตฟอร์มพาไปหน้า checkpoint/ยืนยันตัวตน | ถือว่าสลับสำเร็จแต่ต้องทำต่อเอง (แจ้ง "แพลตฟอร์มขอยืนยันตัวตน ทำในแท็บให้เสร็จแล้วกด อัปเดต session") ไม่พยายามข้ามให้ |
| แท็บเปิดค้างหลายแท็บ | แท็บเก่าถือ state บัญชีเดิม (เช่น ร่างโพสต์) | รีโหลดทุกแท็บของ domain · ก่อนสลับถ้ามี > 1 แท็บ บอกใน popup "จะรีโหลด 3 แท็บ" · ถ้ามีแท็บกำลังพิมพ์อยู่ (ตรวจไม่ได้แน่ชัด) ยอมรับว่าร่างอาจหาย — บอกใน FAQ |
| กดสลับซ้ำ/สองแพลตฟอร์มพร้อมกัน | race | ล็อกต่อแพลตฟอร์ม (FB กับ IG สลับพร้อมกันได้เพราะ domain ไม่ทับกัน) |
| service worker ถูกปิดกลางทาง | cookie ครึ่งๆ | journal ใน `storage.session` → ตอนเริ่มทำงานใหม่ใส่ backup กลับ |
| Incognito | cookie store แยก | v1 ไม่รองรับ (`incognito: "not_allowed"`) |
| partitioned cookie (CHIPS) | `getAll` ไม่คืนถ้าไม่ระบุ partitionKey | ใช้ `getAll({ domain, partitionKey: {} })` เพื่อเอาทุก partition (เป็นเหตุผลของ `minimum_chrome_version`; พฤติกรรมของ `{}` ต้องพิสูจน์ในการ์ด B2) แล้วเก็บ partitionKey ไว้ตอน set |

---

## 4. Permissions

```json
{
  "manifest_version": 3,
  "name": "สลับบัญชี Social",
  "version": "<จาก package.json ตอน build>",
  "minimum_chrome_version": "<ตัวแรกที่ cookies API รองรับ partitionKey — ตรวจเอกสารตอน B1>",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "permissions": ["cookies", "storage", "scripting"],
  "host_permissions": [
    "*://*.facebook.com/*",
    "*://*.instagram.com/*",
    "*://*.youtube.com/*"
  ],
  "incognito": "not_allowed"
}
```
ไม่ใส่ `content_security_policy` — ใช้ค่าเริ่มต้นของ MV3 ซึ่งห้ามสคริปต์ภายนอกและ `eval` อยู่แล้ว

| permission | ใช้ทำอะไร | ทำไมจำเป็น |
|---|---|---|
| `cookies` | อ่าน/ลบ/ใส่ cookie ของ FB, IG | หัวใจของการสลับ; อ่านได้แค่ domain ใน host_permissions |
| `storage` | `storage.local` เก็บรายการบัญชี+ข้อมูลเข้ารหัส (ไม่มีกุญแจ) · `storage.session` (หน่วยความจำ) เก็บกุญแจที่ปลดล็อกแล้ว (raw base64) + journal | ไม่มีที่อื่นให้เก็บ; ไม่ใช้ `storage.sync` (จะส่งขึ้น cloud ของ Google = ผิดหลักข้อมูลอยู่ในเครื่อง) |
| `scripting` | อ่าน `ytcfg` (authuser/pageid) บนหน้า YouTube | ใช้เฉพาะ YouTube; ไม่ต้องใช้ content script ถาวร |
| host `*.facebook.com`, `*.instagram.com` | ให้ `cookies` เข้าถึง domain + `tabs.query({url})` หาแท็บไปรีโหลด | จำกัดแค่ 2 domain |
| host `*.youtube.com` | `scripting` + หา/นำทางแท็บ YouTube | **ไม่ขอ `*.google.com`** เพราะเลือกทาง B |

**ที่ตั้งใจไม่ขอ:** `tabs` (host_permissions พอให้ query แท็บของ 3 domain), `<all_urls>`, `webRequest`, `alarms`, `identity`, `unlimitedStorage`, `storage.sync` · ไม่มี remote code, ไม่มี `externally_connectable`

---

## 5. Data model

**`chrome.storage.local`** (อยู่บนดิสก์)

```ts
type Platform = 'facebook' | 'instagram' | 'youtube';

interface StoreV1 {
  schemaVersion: 1;
  accounts: Account[];                       // metadata — ไม่ใช่ความลับ แสดงได้แม้ล็อกอยู่
  active: Record<Platform, string | null>;   // accountId ที่ใช้อยู่
  vault: Vault | null;                       // null = ยังไม่ตั้งรหัสผ่านหลัก / ยังไม่มีบัญชี FB/IG
}

interface Account {
  id: string;                 // uuid ของ extension เอง
  platform: Platform;
  label: string;              // ชื่อที่ผู้ใช้ตั้ง 1–40 ตัวอักษร
  initials: string;           // คำนวณจาก label ไว้แสดงในวงกลม
  platformUserId?: string;    // FB c_user / IG ds_user_id (ใช้จับคู่ + กันเพิ่มซ้ำ)
  youtube?: { authuser: number; pageid?: string };   // เฉพาะ YouTube — ไม่มี cookie
  status: 'ok' | 'expired' | 'checkpoint';
  createdAt: number;
  lastUsedAt: number | null;
  sessionCapturedAt: number | null;
}

interface Vault {             // ก้อนเข้ารหัสก้อนเดียว
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: 600000; salt: string /*b64 16B*/ };
  iv: string;                 // b64 12B, สุ่มใหม่ทุกครั้งที่เขียน
  ciphertext: string;         // AES-GCM( JSON<SessionMap> )
  check: string;              // AES-GCM ของค่าคงที่ ไว้ตรวจรหัสผ่านผิด/ถูกโดยไม่ถอดทั้งก้อน
}
```

**ข้างใน vault (หลังถอดรหัส)**

```ts
type SessionMap = Record<string /*accountId*/, {
  capturedAt: number;
  cookies: Array<{
    name: string; value: string; domain: string; path: string;
    hostOnly: boolean; secure: boolean; httpOnly: boolean;
    sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
    expirationDate?: number;  // ไม่มี = session cookie
    partitionKey?: { topLevelSite?: string };
  }>;
}>;
```

**`chrome.storage.session`** (อยู่ในหน่วยความจำของ browser ไม่ลงดิสก์ · หายเมื่อปิด Chrome · ค่าต้องเป็น JSON)

```ts
interface SessionArea {
  vaultKey?: string;          // raw AES-256 key แบบ base64 (32 ไบต์) — มีอยู่ = ปลดล็อกแล้ว
  journal?: { platform: Platform; fromId: string | null; toId: string; backup: string /* AES-GCM ของ cookie เดิม */ };
}
```
- access level คงเป็น `TRUSTED_CONTEXTS` (ค่าเริ่มต้น — content script อ่านไม่ได้) และ SW เรียก `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` ซ้ำตอนเริ่ม เพื่อกันใครไปเปลี่ยน
- **กุญแจห้ามลง `storage.local` / IndexedDB / ไฟล์ใดๆ บนดิสก์** — มีที่เดียวคือ `storage.session`
- `backup` ใน journal เข้ารหัสด้วยกุญแจเดียวกัน (journal ไม่เคยถือ cookie แบบ plaintext)

---

## 6. ความปลอดภัย

**หลักคิด:** cookie session ของ FB/IG มีค่า **เท่ากับรหัสผ่าน + 2FA** ใครได้ไปใช้บัญชีได้ทันที และสำเนาของเราใน `storage.local` (LevelDB ไฟล์ธรรมดา) อ่อนกว่า cookie ที่ Chrome เก็บเอง (Chrome เข้ารหัสด้วย keyring ของระบบ) — จึง **เข้ารหัสเป็นค่าบังคับ**

**แบบที่เสนอ: รหัสผ่านหลัก + WebCrypto**
1. ครั้งแรกที่เพิ่มบัญชี FB/IG ให้ตั้ง **รหัสผ่านหลัก อย่างน้อย 10 ตัวอักษร** (แนะนำวลี 4 คำขึ้นไป เช่น "แมวส้ม กินข้าว ริมคลอง ตอนบ่าย") — **ไม่มีตัวเลือก PIN** เหตุผลอยู่ในตารางตัวเลขด้านล่าง · ช่องกรอกมีปุ่มแสดง/ซ่อน · ไม่ตรวจกับรายการรหัสผ่านยอดนิยม (ต้องมี dependency/รายการใหญ่) แต่ปฏิเสธรหัสที่เป็นอักษรซ้ำตัวเดียวหรือเลขเรียง
2. `PBKDF2(รหัสผ่าน, salt สุ่ม 16B, 600,000 รอบ, SHA-256)` → `deriveKey` เป็น AES-GCM 256 บิต **แบบ extractable** (ใช้ครั้งเดียวตอนปลดล็อกเพื่อ export)
3. session ทั้งหมดเข้ารหัสเป็นก้อนเดียว (`Vault`) iv 12B สุ่มใหม่ทุกครั้งที่เขียน
4. **วงจรของกุญแจ** (MV3 service worker ถูกปิดเมื่อว่าง ตัวแปรใน SW จึงหายได้ทุกเมื่อ):
   - ปลดล็อก: derive (extractable) → `exportKey('raw')` → base64 → `storage.session.vaultKey` → ทิ้งตัวแปร extractable ทันที
   - ใช้งาน (ทุกครั้งที่ SW ต้องถอด/เข้ารหัส): อ่าน `vaultKey` → `importKey('raw', …, extractable: false, ['encrypt','decrypt'])` → ได้ `CryptoKey` **non-extractable** ใช้ในหน่วยความจำของ SW (cache ในตัวแปรได้จน SW ถูกปิด)
   - ล็อก: ลบ `vaultKey` + ล้าง cache · ปิด Chrome = `storage.session` หายเอง → ล็อกอัตโนมัติ
   - ผล: ปลดล็อกครั้งเดียวใช้ได้จนปิด Chrome หรือกดล็อกเอง แม้ SW ถูกปิด/ตื่นใหม่หลายรอบ
5. ใส่รหัสผ่านผิด 5 ครั้ง → หน่วง 30 วินาทีต่อครั้ง — **บอกตรงๆ: การหน่วงนี้อยู่ใน extension จึงกันได้แค่คนที่นั่งเดาหน้าเครื่อง กันการเดาออฟไลน์จากไฟล์ `storage.local` ที่ถูกขโมยไปไม่ได้เลย** สิ่งที่กันการเดาออฟไลน์มีแค่ความยาวของรหัสผ่าน × จำนวนรอบ PBKDF2

**YouTube ไม่มี secret** (เก็บแค่ authuser/pageid) จึงสลับได้โดยไม่ต้องปลดล็อก

**ตัวเลขการเดาออฟไลน์ (ถ้าไฟล์ถูกขโมย)**

สมมติฐาน: hashcat mode 10900 (PBKDF2-HMAC-SHA256) บน GTX 1080 Ti (การ์ดปี 2017) ≈ 1.47 MH/s ที่ 999 รอบ (ที่มา: ผล benchmark hashcat ของ 1080 Ti ที่เผยแพร่ เช่น techearl.com/hashcat-benchmarks-nvidia-geforce-gtx-1080-ti) → ที่ 600,000 รอบ ≈ **2,450 ครั้ง/วินาที ต่อการ์ด** · ผู้โจมตีจริงอาจมีการ์ดใหม่หรือหลายใบ จึงคิดอีกกรณีที่ **เร็วกว่า 10 เท่า (≈ 24,500 ครั้ง/วินาที)** — ตัวเลขด้านล่างคือเวลา "เดาครบทุกแบบ" (เฉลี่ยเจอครึ่งหนึ่งของนี้)

| รหัส | จำนวนแบบ | 1080 Ti 1 ใบ | เร็วกว่า 10 เท่า |
|---|---|---|---|
| PIN 6 หลัก | 10^6 | **~7 นาที (408 วินาที)** | ~41 วินาที |
| รหัสจากรายการคำ/รหัสยอดนิยม | ~10^9 | ~4.7 วัน | ~11 ชั่วโมง |
| 10 ตัว สุ่ม a–z เท่านั้น | 26^10 ≈ 1.4×10^14 | ~1,800 ปี | ~180 ปี |
| 10 ตัว สุ่ม a–z + 0–9 | 36^10 ≈ 3.7×10^15 | ~47,000 ปี | ~4,700 ปี |
| วลี 4 คำสุ่มจากรายการ 7,776 คำ | 7776^4 ≈ 3.7×10^15 | ~47,000 ปี | ~4,700 ปี |

(คำนวณ: จำนวนแบบ ÷ ครั้งต่อวินาที — เช่น `10**6 / 2450 ≈ 408 วินาที`)

| ข้อแลกเปลี่ยน | ผล |
|---|---|
| บังคับรหัสผ่าน ≥ 10 ตัว แทน PIN | พิมพ์ยาวขึ้นวันละครั้ง (ตอนเปิด Chrome) แลกกับ: PIN 6 หลักถูกถอดได้ในไม่กี่นาทีถ้าไฟล์หลุด ซึ่งเท่ากับยกบัญชี FB/IG ให้ทันที |
| รหัสผ่านที่คนตั้งเองมักไม่สุ่ม | ตัวเลข "ปี" ข้างบนใช้ได้เฉพาะรหัสที่สุ่มจริง · รหัสที่เป็นคำ/รูปแบบยอดนิยมตกไปอยู่แถว "~10^9" (ชั่วโมงถึงวัน) → UI แนะนำวลีหลายคำ และ README/PRIVACY บอกเรื่องนี้ตรงๆ |
| ลืมรหัสผ่านหลัก | กู้ไม่ได้ (ไม่มี server) → "ล้างข้อมูลทั้งหมด" แล้ว login เพิ่มบัญชีใหม่ — บัญชีบนแพลตฟอร์มไม่เสียหาย แค่ต้อง login ใหม่ |
| กุญแจ raw อยู่ใน `storage.session` ระหว่างปลดล็อก | อยู่ในหน่วยความจำของ browser เท่านั้น (ไม่ลงดิสก์) context ของ extension เองอ่านได้ — ยอมรับ เพราะเป็นทางเดียวที่ทำให้ "ปลดล็อกครั้งเดียว" ใช้ได้กับ SW ที่ถูกปิดบ่อย · มัลแวร์ที่อ่านหน่วยความจำ Chrome ได้ ก็ขโมย cookie ของ Chrome ได้ตรงๆ อยู่แล้ว |
| ไม่เข้ารหัส metadata (ชื่อบัญชี) | แสดงรายการได้แม้ล็อก ใช้ง่ายกว่า; ชื่อที่ผู้ใช้ตั้งไม่ใช่ความลับระดับเดียวกับ cookie |

**กฎที่ห้ามละเมิดในโค้ดจริง:** ไม่มี `fetch`/`XMLHttpRequest` ไปที่ใดเลยนอกจากที่หน้าเว็บโหลดเอง · ไม่ log ค่า cookie ใน console · CSP ของ extension ค่าเริ่มต้น (ไม่มี `unsafe-eval`, ไม่โหลดสคริปต์ภายนอก, ไม่โหลดฟอนต์จากเน็ต) · ไม่มี analytics

---

## 7. ความเสี่ยง

| ความเสี่ยง | โอกาส | ผล | ลดความเสี่ยงอย่างไร |
|---|---|---|---|
| **นโยบายแพลตฟอร์ม** — Meta ห้ามใช้วิธีอัตโนมัติเข้าถึงบริการ / ห้ามแชร์บัญชี | กลาง | บัญชีถูกจำกัด/ระงับ | ไม่ทำอะไรอัตโนมัตินอกจากใส่ cookie ของผู้ใช้เองที่ได้จากการ login ด้วยมือ บนเครื่องเดิม · ไม่ยิง request เอง · บอกผู้ใช้ชัดว่าใช้กับบัญชีตัวเองเท่านั้น ไม่ใช่เครื่องมือแชร์บัญชี |
| **Chrome Web Store** — extension ที่จัดการ cookie ต้องแจ้ง privacy ชัด | กลาง | ไม่ผ่านรีวิว | privacy policy ระบุ "ข้อมูลอยู่ในเครื่อง ไม่ส่งออก" + ขอ permission น้อยที่สุด + ไม่มี remote code |
| **โดน checkpoint / บังคับ login ใหม่** | กลาง–สูง (บัญชีใหม่, สลับถี่) | ต้องยืนยันตัวตน เสียเวลา | ไม่ swap device cookie (denylist) · ไม่สลับวนถี่ๆ · จับ checkpoint ได้แล้วบอกผู้ใช้ ไม่พยายามข้าม |
| **session ถูกยกเลิก** (เปลี่ยนรหัส, logout ทุกเครื่อง, กด logout บนเว็บ, หมดอายุ ~90 วัน+) | สูงในระยะยาว | สลับไม่ได้ ต้อง login ใหม่ | ตรวจผลทุกครั้ง + ใส่ backup กลับ + ปุ่ม "อัปเดต session" · เก็บ session ล่าสุดทับทุกครั้งที่สลับออก (ขั้น 1) จึงสดอยู่เสมอ |
| **แพลตฟอร์มเปลี่ยนชื่อ cookie / ผูก session กับเครื่องแบบ DBSC** | กลาง (Google ทำแล้ว, Meta อาจตาม) | กลไก swap ใช้ไม่ได้ | denylist ทนต่อชื่อใหม่ · YouTube ไม่ swap อยู่แล้ว · แยกโค้ดต่อแพลตฟอร์ม (`platforms/*.js`) ปิดทีละตัวได้ |
| **ข้อมูลรั่วจากเครื่อง** | ต่ำ | ยึดบัญชีได้ | เข้ารหัสบังคับ (ข้อ 6) |
| **ผู้ใช้เข้าใจผิดว่าแท็บอื่นยังเป็นบัญชีเดิม** | กลาง | โพสต์ผิดบัญชี | รีโหลดทุกแท็บ + toast บอกชื่อบัญชีใหม่ + badge ตัวอักษรย่อบนไอคอน extension (v1.1) |

---

## 8. โครงไฟล์ตัวจริง + สัญญาของแต่ละโมดูล + เทสต์ + การแบ่งการ์ด

> ผู้ใช้จะสร้างจริงทันทีหลัง QC ผ่าน และจะ publish ลง git repo — ข้อนี้กับข้อ 9 ต้องพอให้สร้างตามได้โดยไม่ต้องตัดสินใจใหม่

### 8.1 โครงไฟล์ (repo ใหม่ ชื่อแนะนำ `social-account-switcher`)

```
social-account-switcher/
├─ src/
│  ├─ manifest.json            # เขียนมือ (ดูข้อ 4 + 9.2) — version ถูกเขียนทับจาก package.json ตอน build
│  ├─ background/
│  │  ├─ service-worker.ts     # entry: ลงทะเบียน onMessage, onStartup → recoverJournal()
│  │  ├─ switcher.ts           # switchAccount() ตามขั้น 0–6 ข้อ 3.0, ล็อกต่อแพลตฟอร์ม
│  │  ├─ journal.ts            # write/clear/recover ใน storage.session
│  │  ├─ keyring.ts            # กุญแจใน storage.session (export raw ↔ import non-extractable)
│  │  └─ platforms/
│  │     ├─ types.ts           # interface CookiePlatform / YoutubePlatform
│  │     ├─ facebook.ts
│  │     ├─ instagram.ts
│  │     └─ youtube.ts
│  ├─ lib/
│  │  ├─ cookies.ts            # snapshot / clear / restore — ไม่มี state
│  │  ├─ vault.ts              # PBKDF2 + AES-GCM
│  │  ├─ store.ts              # schema v1, migrate(), CRUD บัญชี
│  │  ├─ messages.ts           # ชนิดข้อความ popup ⇄ SW (discriminated union)
│  │  └─ result.ts             # type Result<T, E> — ห้าม throw ข้ามขอบ message
│  └─ popup/
│     ├─ index.html  popup.css  # ยกจาก mockup/popup.html (CSS token เดิม)
│     ├─ main.ts               # render + event, คุยกับ SW ผ่าน messages.ts เท่านั้น
│     └─ view.ts               # ฟังก์ชัน render ล้วน (state → DOM) ทดสอบได้ด้วย happy-dom
├─ public/icons/16.png 32.png 48.png 128.png
├─ tests/
│  ├─ fakes/chrome.ts          # chrome.cookies/storage/tabs/scripting ปลอม แบบ in-memory
│  ├─ setup.ts                # preload ของ bun test (ลง happy-dom ให้เทสต์ view)
│  ├─ unit/*.test.ts           # bun test
│  └─ e2e/
│     ├─ fixtures.ts           # launchPersistentContext + --load-extension
│     ├─ fake-sites/server.ts  # https localhost เลียน FB/IG (ตั้ง/ตรวจ cookie)
│     └─ *.spec.ts
├─ scripts/zip.ts              # สร้าง zip สำหรับ Chrome Web Store (ข้อ 9.7)
├─ scripts/check-permissions.ts # manifest ต้องตรงรายการอนุญาต
├─ .github/workflows/ci.yml  release.yml   .github/dependabot.yml
├─ docs/design.md  docs/store-listing.md
├─ README.md  PRIVACY.md  LICENSE  CHANGELOG.md  SECURITY.md
├─ package.json  bun.lock  bunfig.toml  tsconfig.json  vite.config.ts  playwright.config.ts
├─ biome.json  .editorconfig  .gitignore
```

### 8.2 สัญญาของโมดูล (เขียนตามนี้)

```ts
// lib/result.ts
export type Result<T, E extends string = string> = { ok: true; value: T } | { ok: false; error: E };

// background/platforms/types.ts
export interface CookiePlatform {
  id: 'facebook' | 'instagram';
  label: string;                         // 'Facebook'
  cookieDomain: string;                  // 'facebook.com'
  tabPatterns: string[];                 // ['*://*.facebook.com/*']
  idCookie: string;                      // 'c_user' | 'ds_user_id'
  deviceCookies: ReadonlySet<string>;    // denylist ข้อ 3.1/3.2
  loginUrl: string;
  isCheckpointUrl(url: string): boolean; // /checkpoint/, /challenge/
}

// lib/cookies.ts — ทุกฟังก์ชันรับ chrome.cookies เป็น parameter (inject ได้ในเทสต์)
export function snapshot(api: CookiesApi, p: CookiePlatform): Promise<StoredCookie[]>;
export function clear(api: CookiesApi, p: CookiePlatform): Promise<number>;        // คืนจำนวนที่ลบ
export function restore(api: CookiesApi, cookies: StoredCookie[], now: number): Promise<Result<number, 'all_expired'>>;
export function currentUserId(api: CookiesApi, p: CookiePlatform): Promise<string | null>;

// lib/vault.ts — กุญแจที่ใช้งานเป็น non-extractable เสมอ; ตัว extractable มีชีวิตแค่ใน unlock/createVault
export function validatePassword(pw: string): Result<void, 'too_short' | 'too_simple'>;   // ≥ 10 ตัว, ไม่ซ้ำตัวเดียว/เรียง
export function createVault(pw: string, data: SessionMap): Promise<{ vault: Vault; rawKeyB64: string }>;
export function unlock(pw: string, vault: Vault): Promise<Result<string /* rawKeyB64 */, 'wrong_password'>>;
export function importSessionKey(rawKeyB64: string): Promise<CryptoKey>;  // importKey(raw, extractable=false)
export function readVault(key: CryptoKey, vault: Vault): Promise<SessionMap>;
export function writeVault(key: CryptoKey, vault: Vault, data: SessionMap): Promise<Vault>; // iv ใหม่ทุกครั้ง

// background/keyring.ts — ที่เดียวที่แตะ storage.session.vaultKey
export function storeKey(session: StorageArea, rawKeyB64: string): Promise<void>;
export function getKey(session: StorageArea): Promise<CryptoKey | null>;  // null = ล็อกอยู่; cache ในตัวแปรจน SW ถูกปิด
export function lock(session: StorageArea): Promise<void>;

// background/switcher.ts
export type SwitchError = 'locked' | 'busy' | 'expired' | 'checkpoint' | 'not_found' | 'unsaved_current';
export function switchAccount(deps: Deps, platform: Platform, accountId: string,
  opts?: { force?: boolean }): Promise<Result<{ reloadedTabs: number }, SwitchError>>;

// lib/messages.ts — popup ส่งได้แค่ชนิดนี้, SW ตอบ Result เสมอ
export type Request =
  | { type: 'state.get' }
  | { type: 'vault.unlock'; password: string } | { type: 'vault.lock' } | { type: 'vault.setup'; password: string }
  | { type: 'vault.wipe' }   // ลืมรหัสผ่าน = ล้างข้อมูลทั้งหมด (ยืนยัน inline ใน popup)
  | { type: 'account.addCurrent'; platform: Platform; label: string }
  | { type: 'account.updateSession'; accountId: string }
  | { type: 'account.rename'; accountId: string; label: string }
  | { type: 'account.remove'; accountId: string }
  | { type: 'account.switch'; accountId: string; force?: boolean };
```

**กติกาโค้ด:** ทุกฟังก์ชันใน `lib/` และ `switcher.ts` รับ dependency (`chrome.*`, `now()`, `crypto`) ผ่าน parameter → เทสต์ได้โดยไม่ต้อง mock global · SW ตรวจ `sender.id === chrome.runtime.id` และตรวจรูปข้อความทุกครั้งก่อนทำ · popup ไม่แตะ `chrome.cookies` ตรงๆ

### 8.3 เทสต์ที่ต้องผ่าน

**unit (`bun test` + `tests/fakes/chrome.ts`, coverage ของ `lib/` + `background/` ≥ 90% บรรทัด)**
1. `snapshot` กรอง device cookie ออกตาม denylist ของแต่ละแพลตฟอร์ม และไม่แตะ domain อื่น
2. `restore` ไม่ใส่ `domain` ให้ host-only cookie, ข้ามตัวที่หมดอายุ (ทั้งหมดหมด → `all_expired`), คง `partitionKey`, `sameSite` ถูกตัว
3. `clear` สร้าง url ถูก (`https`/`http` ตาม secure + domain + path) และลบครบรวม partitioned
4. `vault`: เข้ารหัส→ถอดได้ค่าเดิม · รหัสผ่านผิด → `wrong_password` · iv ไม่ซ้ำ 1,000 รอบ · ciphertext ไม่มีค่า cookie เป็น plaintext · `validatePassword` ปฏิเสธ < 10 ตัว/ซ้ำ/เรียง · `importSessionKey` คืน key ที่ `extractable === false`
4b. `keyring`: กุญแจถูกเขียนลง `storage.session` เท่านั้น (fake ของ `storage.local` ต้องไม่มีคีย์ใดที่มีค่ากุญแจ) · SW "ตื่นใหม่" (ล้าง cache) แล้ว `getKey` ยังได้ key · `lock` แล้วได้ null · journal backup ไม่มี cookie แบบ plaintext
5. `switcher`: ลำดับ snapshot → save → clear → restore → reload ถูก · กดซ้ำระหว่างทำ → `busy` · FB+IG พร้อมกันได้
6. `switcher`: ผลตรวจไม่ตรง → ใส่ backup กลับ + status `expired` · เจอ URL checkpoint → `checkpoint`
7. journal ค้าง → ตอน SW เริ่มใหม่ rollback แล้วล้าง journal
8. `youtube`: URL ถูกทั้งมี/ไม่มี pageid · `next` เก็บ path เดิม · encode ถูก
9. `store`: เพิ่มบัญชีซ้ำ (platformUserId เดิม) → `duplicate` · ชื่อว่าง/ยาวเกิน 40 ถูกปฏิเสธ · migrate จาก schema ไม่รู้จัก → ไม่ลบข้อมูล
10. `messages`: ข้อความผิดรูป / sender ไม่ใช่ extension → ถูกปฏิเสธ
11. `popup/view.ts`: render ทุกสถานะใน happy-dom (ว่าง/มีบัญชี/กำลังสลับ/สำเร็จ/error/เปลี่ยนชื่อ/ยืนยันลบ/ล็อก)

**e2e (Playwright Chromium + extension unpacked จาก `dist/`)**
12. เว็บปลอม `www.facebook.com`/`www.instagram.com` → map ไป https localhost (`--host-resolver-rules` + cert self-signed ที่สร้างตอนเทสต์ + `ignoreHTTPSErrors`) หน้าเว็บแสดง user จาก cookie: เพิ่ม 2 บัญชี → สลับไปมา 5 รอบ → หน้าแสดงคนถูก
13. server ปลอมยกเลิก session → popup แสดง error + บัญชีเดิมยังใช้ได้
14. รีโหลดครบทุกแท็บของ domain และไม่แตะแท็บ domain อื่น
15. ล็อก → ใส่รหัสผ่านหลัก → สลับได้ · รหัสผิดแสดง error inline · หยุด SW (`chrome://serviceworker-internals` หรือ CDP) แล้วสลับได้โดยไม่ต้องใส่รหัสใหม่
16. **ไม่มี request ออกจาก extension** (ดัก `context.on('request')` แยก request ที่มาจาก SW/popup) และไม่มี dialog
17. ภาพ popup ทุกสถานะ (สว่าง/มืด) เทียบ snapshot

**เช็คด้วยมือก่อน publish (บัญชีทดสอบเท่านั้น — ต้องให้ผู้ใช้ทำ/เตรียมบัญชี)**
18. FB 2 บัญชี / IG 2 บัญชี สลับ 10 รอบในหนึ่งวัน → ไม่โดน checkpoint
19. YouTube: รูปแบบ `signin?action_handle_signin=true&authuser=&pageid=` ใช้ได้กับ Brand Account และ Gmail ในแท็บอื่นไม่เปลี่ยนบัญชี

### 8.4 เสนอการแบ่งการ์ดสร้างจริง

| การ์ด | งาน | เสร็จเมื่อ | ต้องรอ |
|---|---|---|---|
| **B1 โครง repo + CI** | ทุกอย่างในข้อ 9 (Bun, tsconfig strict, Biome, bun test, playwright skeleton, workflows, zip, README/PRIVACY/LICENSE) + manifest + SW/popup ว่าง | `bun run check` ผ่าน, `bun outdated` ว่าง, CI เขียว, `bun run zip` ได้ไฟล์ที่โหลด unpacked ได้ · **ยืนยันว่า `setup-bun` กับ `bun-version-file: package.json` อ่านฟิลด์ `packageManager` ได้จริง** (ถ้าไม่ได้ ใช้ไฟล์ `.bun-version` หรือ `bun-version` ตรงๆ แล้วแก้ข้อ 9.3/9.8) | — |
| **B2 lib แกน** | `cookies.ts`, `vault.ts`, `keyring.ts`, `store.ts`, `result.ts`, `fakes/chrome.ts` | เทสต์ 1–4b, 9 ผ่าน + coverage · **พิสูจน์กับ Chrome จริง (Playwright Chromium) ว่า `cookies.getAll({ domain, partitionKey: {} })` คืน cookie ทั้งแบบมีและไม่มี partition** (เอกสารทางการไม่ระบุพฤติกรรม `{}`) ถ้าไม่ได้ ให้เรียก 2 ครั้ง (ไม่ระบุ + ระบุ topLevelSite) แล้วรวม | B1 |
| **B3 สลับ FB/IG** | `switcher.ts`, `journal.ts`, `facebook.ts`, `instagram.ts`, `messages.ts`, SW | เทสต์ 5–7, 10 ผ่าน | B2 |
| **B4 YouTube** | `youtube.ts` (ytcfg + URL) | เทสต์ 8 ผ่าน | B1 (ขนาน B2/B3 ได้) |
| **B5 popup จริง** | ยก mockup → `popup/` ต่อ messages | เทสต์ 11 ผ่าน + ภาพตรง mockup | B3, B4 |
| **B6 e2e** | เว็บปลอม + spec 12–17 | e2e เขียวใน CI | B5 |
| **B7 เตรียม publish** | ไอคอน, `store-listing.md`, ภาพสำหรับ store, CHANGELOG, tag `v0.1.0` → release zip | release.yml ได้ zip แนบ · ผู้ใช้ทำเช็คมือ 18–19 | B6 + ผู้ใช้ |

แต่ละการ์ด = 1 branch `card/t-xxx` 1 PR ทุกการ์ดต้องผ่าน `bun run check` และ `bun outdated` ว่าง ก่อนส่ง QC

---

## 9. Repo พร้อม publish (best practice)

> ผู้ใช้กำหนด: **Bun** (package manager + รันสคริปต์ + unit test), **Biome** (lint + format), **dependency ล่าสุดทุกตัว** · ในแบบนี้ **จงใจไม่เขียนเลข version ใดๆ** — การ์ด B1 ติดตั้งด้วย `bun add -d <ชื่อ>` (ไม่ระบุ version = ได้ตัวล่าสุด) แล้วต้องผ่าน `bun outdated` ว่าง

### 9.1 เครื่องมือ (สรุป)

| งาน | เลือก | เหตุผลสั้น |
|---|---|---|
| package manager + สคริปต์ | **Bun** — `bun install`, `bun run`, lockfile `bun.lock` (ข้อความ อ่าน diff ได้) | ผู้ใช้กำหนด · เร็ว · ตัวเดียวทำได้ทั้ง install/run/test |
| build | **Vite** (รันผ่าน `bun run` / `bunx --bun vite`) | ดู 9.2 |
| ภาษา | **TypeScript strict** — ตรวจด้วย `tsc --noEmit` (Bun/Vite แค่ตัด type ไม่ตรวจ) | |
| lint + format | **Biome** ตัวเดียว (`biome.json`) | ผู้ใช้กำหนด · แทน ESLint+Prettier · dependency เดียว ไม่มี plugin chain |
| unit test | **`bun test`** + `happy-dom` (เฉพาะเทสต์ view) | ผู้ใช้กำหนด · มี mock/spy, coverage, `crypto.subtle` ในตัว — ไม่มีเหตุผลพอให้ใช้ตัวอื่น |
| e2e | **`@playwright/test`** รันด้วย `bunx playwright test` | โหลด extension unpacked ใน Chromium ได้ (Puppeteer ก็ทำได้ แต่ Playwright มี test runner, fixture, trace และ report ครบในตัว ไม่ต้องประกอบเอง) · **ข้อยกเว้นที่มีเหตุผล:** test runner ของ Playwright รองรับทางการบน Node — ปล่อยให้ `bunx` รันตาม shebang (Node) ไม่ใส่ `--bun` (GitHub runner มี Node อยู่แล้ว) |
| zip | สคริปต์ `scripts/zip.ts` รันด้วย `bun` + `fflate` | ไม่ต้องพึ่ง `zip` ของระบบ ผลเหมือนกันทุกเครื่อง |
| CI | GitHub Actions + `oven-sh/setup-bun` | ผู้ใช้กำหนด |

### 9.2 framework: **Vite + TypeScript ล้วน** (ไม่ใช้ WXT)

| | WXT | **Vite + TS ล้วน (เลือก)** |
|---|---|---|
| manifest | สร้างจาก config/ไฟล์ entry อัตโนมัติ | เขียนมือ `src/manifest.json` — **คนรีวิว (และ Chrome Web Store) เห็น permission ตรงๆ ใน repo** |
| dependency | framework + auto-import + module หลายชั้น | `vite` ตัวเดียวฝั่ง build |
| dev | HMR + รีโหลด extension ให้เอง | `vite build --watch` + กดรีโหลดใน `chrome://extensions` (popup 1 หน้า + SW 1 ไฟล์ พอรับได้) |
| zip / หลาย browser | `wxt zip`, Firefox/Safari ในตัว | สคริปต์ zip เอง · v1 ทำ Chrome อย่างเดียว |
| ทางถอย | — | WXT สร้างบน Vite → วันหนึ่งจะย้ายไป WXT โค้ด `lib/` และ `background/` ไม่ต้องแก้ |

**เหตุผล:** extension นี้ถือ cookie session (เท่ารหัสผ่าน) ทุก dependency ใน build คือ supply chain ที่ต้องเชื่อใจ ยิ่งน้อยยิ่งดี งานมีแค่ 2 entry (SW + popup) ไม่มี content script ถาวร ข้อดีหลักของ WXT (HMR, หลาย browser, manifest อัตโนมัติ) จึงไม่คุ้ม และ manifest เขียนมือตรวจง่ายกว่า · ส่วน `Bun.build` ล้วนก็ทำได้ แต่ Vite จัดการ HTML entry + CSS + การตั้ง target browser ได้ชัดกว่า และเป็นทางเดียวกับ WXT ถ้าย้ายภายหลัง → **ย้ายไป WXT เมื่อจะทำ Firefox/Edge หรือมีหลายหน้า UI**

`vite.config.ts`: `build.rollupOptions.input = { popup: 'src/popup/index.html', 'service-worker': 'src/background/service-worker.ts' }`, `output.entryFileNames: '[name].js'`, `build.target` = Chrome ตาม `minimum_chrome_version`, `sourcemap: false` ตอน build จริง, `modulePreload: false` (ไม่ฉีด polyfill) · plugin เล็กๆ ใน config คัด `src/manifest.json` ไป `dist/` แล้วใส่ `version` จาก package.json

### 9.3 Dependency: ล่าสุดทุกตัว

- **runtime dependency = 0** (โค้ดที่ไปอยู่ใน extension มีแต่ของเราเอง)
- devDependencies ที่อนุญาต: `typescript`, `vite`, `@biomejs/biome`, `@types/chrome`, `@types/bun`, `happy-dom`, `@happy-dom/global-registrator`, `@playwright/test`, `fflate` — เพิ่มตัวใหม่ต้องเขียนเหตุผลใน PR
- ติดตั้งด้วย `bun add -d <ชื่อ>` ไม่ระบุ version → ได้ตัวล่าสุด ณ วันสร้าง · `bun.lock` commit เสมอ · CI ใช้ `bun install --frozen-lockfile`
- เวอร์ชันของ Bun เอง: ใส่ `"packageManager": "bun@<เวอร์ชันล่าสุด ณ วันสร้าง>"` ใน package.json แล้ว CI อ่านจากไฟล์นั้น (`bun-version-file`) — เครื่องคนพัฒนากับ CI ตรงกัน (การอ่านฟิลด์นี้ต้องยืนยันใน B1)
- GitHub Actions ทุกตัว pin ด้วย commit SHA ของ release ล่าสุด ณ วันสร้าง (ใส่ชื่อ tag เป็น comment ข้างหลัง)
- **ด่านก่อนส่งทุกการ์ด:** `bun outdated` ต้องไม่มีรายการ (เป็นข้อหนึ่งใน "เสร็จเมื่อ")
- หลังจากนั้นอัปเดตผ่าน **Dependabot** (`package-ecosystem: bun` + `github-actions`, รายสัปดาห์, รวม PR เป็นกลุ่ม) — ไม่ใส่ `bun outdated` เป็นด่านบล็อกใน CI เพราะ release ใหม่ของคนอื่นจะทำ CI แดงทั้งที่โค้ดเราไม่เปลี่ยน
- ข้อควรระวังของ "ล่าสุดเสมอ": ตัว major ใหม่อาจเปลี่ยน API/config (เช่น schema ของ `biome.json`) → การ์ด B1 ต้องเขียน config ตามเอกสารของเวอร์ชันที่ได้จริง ไม่ใช่ตามความจำ

### 9.4 TypeScript

- `tsconfig.json` (โค้ด extension): `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"verbatimModuleSyntax": true`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"noEmit": true`, `"types": ["chrome", "vite/client"]`, `include: ["src"]`
- `tests/tsconfig.json` extends ตัวบน เพิ่ม `"types": ["chrome", "bun"]` — **แยกไว้เพื่อไม่ให้ type ของ Bun หลุดเข้าโค้ด extension** (ใน Chrome ไม่มี `Bun.*`)
- `"typecheck": "tsc -p tsconfig.json && tsc -p tests/tsconfig.json"`

### 9.5 Biome (lint + format)

- `biome.json`: เปิด `recommended` + formatter (`indentStyle: space`, `lineWidth: 100`, quote เดี่ยว) + `organizeImports` · ไฟล์ที่ข้าม: `dist/`, `release/`, `coverage/`, `playwright-report/`, `mockup/`
- กฎบังคับนโยบาย "ไม่ส่งข้อมูลออก / ไม่ใช้ dialog": `noRestrictedGlobals` ห้าม `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `alert`, `confirm`, `prompt`, `Bun` (ใน `src/`) — ทำด้วยเครื่องมือ ไม่ใช่ความจำ
- `noConsole` ยกเว้น `warn`/`error` · `noExplicitAny` = error · `useAwait` / กฎ promise ที่ลอย (ถ้าเวอร์ชันที่ได้มีกฎแบบ `noFloatingPromises` ให้เปิดเป็น error — โค้ด chrome API เป็น async ทั้งหมด ลืม await = cookie ครึ่งๆ; ถ้าไม่มี ชดเชยด้วยเทสต์ลำดับในข้อ 8.3 ข้อ 5)
- CI ใช้ `biome ci .` (ตรวจทั้ง lint + format ไม่แก้ไฟล์) · เครื่องคนใช้ `biome check --write .`
- ไม่ใช้ git hook (ลดของที่ต้องติดตั้ง) — CI เป็นด่านจริง; README บอกให้รัน `bun run check` ก่อน commit

### 9.6 Scripts + ค่าตั้งเทสต์

```json
{
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json && tsc -p tests/tsconfig.json",
    "lint": "biome ci .",
    "fix": "biome check --write .",
    "test": "bun test tests/unit",
    "e2e": "playwright test",
    "perm:check": "bun scripts/check-permissions.ts",
    "zip": "bun run build && bun scripts/zip.ts",
    "check": "bun run typecheck && bun run lint && bun run test && bun run build && bun run perm:check"
  }
}
```

`bunfig.toml`:
```toml
[install]
exact = true                 # bun add เขียน version ตรงตัว ไม่ใส่ ^ — lockfile + package.json ตรงกัน

[test]
preload = ["./tests/setup.ts"]       # GlobalRegistrator.register() ของ happy-dom
coverage = true
coverageThreshold = { lines = 0.9, functions = 0.9 }
coverageSkipTestFiles = true
```
(entry ที่แค่ต่อสาย เช่น `popup/main.ts`, `service-worker.ts` ไม่นับ coverage — ถ้า bun ที่ได้ตั้ง ignore pattern ได้ให้ใส่ ไม่ได้ก็ทำให้ไฟล์เหล่านั้นบางที่สุด)

**unit:** `tests/fakes/chrome.ts` เขียนเอง — cookie store in-memory ที่ทำตามกติกา hostOnly/secure/path/partitionKey/expiry, `storage.local/session`, `tabs.query/reload/update`, `scripting.executeScript` คืนค่าที่กำหนด — แทน lib mock สำเร็จรูป (ส่วนใหญ่เลิกดูแลแล้ว และ mock แบบไม่มีกติกาจับบั๊กเรื่อง cookie ไม่ได้) · ฟังก์ชันทุกตัวรับ dependency ผ่าน parameter (ข้อ 8.2) จึงใช้ `mock()` ของ `bun:test` แค่จุดที่ต้องการ spy ลำดับการเรียก

**e2e:** fixture `chromium.launchPersistentContext(tmpDir, { channel: 'chromium', args: ['--disable-extensions-except=<dist>', '--load-extension=<dist>', '--host-resolver-rules=MAP www.facebook.com 127.0.0.1:<port>, MAP www.instagram.com 127.0.0.1:<port>'], ignoreHTTPSErrors: true })` → หา extension id จาก `context.serviceWorkers()` → เปิด `chrome-extension://<id>/popup.html` เป็นหน้า · ใช้ Chromium ที่ Playwright ติดตั้ง (Chrome ตัวขายจริงตัดการโหลด extension ทาง flag แล้ว) · cert self-signed สร้างตอนรัน · **ไม่แตะเว็บจริงใน CI**

### 9.7 สคริปต์ zip สำหรับ Chrome Web Store

`scripts/check-permissions.ts` — `dist/manifest.json` ต้องมี permissions/host_permissions **ตรงกับรายการอนุญาต** (`cookies`, `storage`, `scripting` + 3 host ข้อ 4) เกิน/ขาด = ล้ม

`scripts/zip.ts`
1. รัน check-permissions · ตรวจ `version` ใน manifest = package.json
2. ตรวจ `dist/`: ไม่มี `*.map`, ไม่มี `<script src="http…">` / `import("http…")`, ไม่มี `eval(` / `new Function(`, ไม่มี `fetch(`/`sendBeacon` หลุดมา (ด่านที่ 2 ต่อจาก Biome)
3. zip เนื้อหา `dist/` (manifest อยู่รากของ zip) → `release/social-account-switcher-v<version>.zip` แบบ deterministic (เรียงชื่อไฟล์, เวลาไฟล์คงที่) แล้วพิมพ์ SHA-256

### 9.8 GitHub Actions

`ci.yml` — on `push` (main) + `pull_request`:
```yaml
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>            # pin SHA ของ release ล่าสุด
      - uses: oven-sh/setup-bun@<sha>
        with: { bun-version-file: package.json }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run test
      - run: bun run build
      - run: bun run perm:check
      - run: bunx playwright install --with-deps chromium
      - run: bun run e2e
      - run: bun scripts/zip.ts
      - uses: actions/upload-artifact@<sha>
        with: { name: extension-zip, path: release/*.zip, retention-days: 14 }
      - if: failure()
        uses: actions/upload-artifact@<sha>
        with: { name: playwright-report, path: playwright-report/ }
```
`release.yml` — on tag `v*`: ทำชุดเดียวกัน แล้วแนบ zip + SHA-256 เข้า GitHub Release (`permissions: contents: write` เฉพาะ job นี้) · **อัปโหลดเข้า Chrome Web Store ทำมือ** ใน v1 (ไม่เก็บ token ของ store ใน repo) · `.github/dependabot.yml` ตามข้อ 9.3

### 9.9 เอกสาร + ไฟล์ที่ต้องมี

| ไฟล์ | เนื้อหา |
|---|---|
| `README.md` | ทำอะไร (ภาพ popup), ติดตั้งจาก store / โหลด unpacked จาก release zip, ใช้ 3 ขั้น, **ข้อจำกัดและความเสี่ยงแบบสั้น (ข้อ 7)**, พัฒนา (`bun install`, `bun run dev`, `bun run check`), โครงไฟล์, วิธี release |
| `PRIVACY.md` | extension นี้ **เข้าถึง cookie** ของ 3 domain: เก็บอะไร (ข้อ 5), เก็บที่ไหน (เครื่องผู้ใช้เท่านั้น), เข้ารหัสอย่างไร + **ความแข็งแรงขึ้นกับรหัสผ่านหลัก (ตารางตัวเลขข้อ 6 แบบย่อ) และการหน่วงหลังใส่ผิดไม่กันการเดาจากไฟล์ที่ถูกขโมย**, **ไม่ส่งออก ไม่มี server ไม่มี analytics ไม่ขาย/แชร์**, permission แต่ละตัวใช้ทำอะไร, วิธีลบข้อมูลทั้งหมด, ช่องทางติดต่อ — ใช้เป็น URL นโยบายความเป็นส่วนตัวในหน้า store |
| `LICENSE` | MIT (ปี + ชื่อเจ้าของ repo — การ์ด B1 ถามผู้ใช้ว่าจะใส่ชื่ออะไร) |
| `SECURITY.md` | แจ้งช่องโหว่ทาง GitHub private vulnerability reporting |
| `CHANGELOG.md` | Keep a Changelog + SemVer |
| `docs/store-listing.md` | ข้อความหน้า store (ไทย/อังกฤษ), เหตุผลขอแต่ละ permission (ช่อง justification ของ store), single purpose: "สลับบัญชีที่ผู้ใช้ login ไว้เองบน Facebook, Instagram, YouTube" |
| `.gitignore` | `node_modules/ dist/ release/ coverage/ playwright-report/ test-results/ *.pem .env*` — **ไม่มีความลับหรือไฟล์ build ใน repo** (cert ของ e2e สร้างตอนรัน) |
| `.editorconfig` | utf-8, LF, เว้นวรรค 2 |

### 9.10 กติกาความปลอดภัยของ repo

- runtime dependency 0 · ไม่โหลดโค้ด/ฟอนต์/รูปจากภายนอก (MV3 + Web Store ห้าม remote code อยู่แล้ว) · ฟอนต์ใช้ของระบบ
- permission จะเพิ่มต้องแก้ 3 ที่พร้อมกัน: manifest, รายการอนุญาตใน `check-permissions.ts`, `PRIVACY.md` — ลืมที่ใด CI ล้ม
- แนะนำตั้งค่าบน GitHub: branch protection `main` (ต้องผ่าน CI), secret scanning, Dependabot alerts
- **ไม่ push remote ในการ์ดนี้** — ผู้ใช้เป็นคนสร้าง repo ปลายทางและ push เอง
