# mockup — popup ของ extension สลับบัญชี

- `popup.html` — เปิดใน browser ได้เลย (ดับเบิลคลิก/ลากเข้า Chrome) ข้อมูลปลอมทั้งหมด ไม่เรียก API ของ extension ไม่ใช้เน็ต
  แผง "ตัวควบคุม mockup" ด้านข้างใช้กระโดดไปแต่ละสถานะ + สลับธีม · รหัสผ่านหลักของ mockup: `orange-cat-2026`
- `shots/` — ภาพทุกสถานะ (`01…12-*` = ลำดับ flow ที่ e2e คลิก, `light-*` / `dark-*` = ทุกสถานะทั้งสองธีม)
- `e2e/popup.e2e.mjs` — Playwright คลิกผ่านทุกสถานะ ถ่ายภาพลง `shots/` และเขียน `e2e/e2e.log` (path ใน log เป็น path จากราก repo)

## รัน e2e

ต้องมี Node และแพ็กเกจ `playwright` (ไม่ได้ติดตั้งใน repo นี้ เพราะ repo นี้มีแค่แบบ — ตัวจริงใช้ `@playwright/test` ตาม docs/design.md ข้อ 9)

```bash
# 1) ถ้ามี playwright ติดตั้งให้ require เจออยู่แล้ว (เช่น NODE_PATH หรือ node_modules ข้างบน) รันได้เลย
node mockup/e2e/popup.e2e.mjs

# 2) ถ้าไม่มี: ชี้ไปที่แพ็กเกจ playwright ที่ติดตั้งไว้ที่อื่น
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node mockup/e2e/popup.e2e.mjs

# 3) ถ้า browser ของ playwright ตัวนั้นยังไม่ได้ติดตั้ง (revision ไม่ตรง) ชี้ไปที่ chrome/chromium ที่มี
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
CHROMIUM_PATH=~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome \
node mockup/e2e/popup.e2e.mjs
```

| ตัวแปร | ต้องตั้งเมื่อ | ค่า |
|---|---|---|
| `PLAYWRIGHT_MODULE` | `require('playwright')` หาไม่เจอ | path ของโฟลเดอร์แพ็กเกจ `playwright` |
| `CHROMIUM_PATH` | browser ที่ playwright ตัวนั้นต้องการยังไม่ได้ติดตั้ง | ไฟล์ chrome/chromium ที่รันได้ |

ผล: exit 0 = ผ่านทุกข้อ · exit 1 = มีข้อล้ม (ดู `FAIL` ใน log) · exit 2 = หา playwright ไม่เจอ
