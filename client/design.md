# Design — บัตรสะสมแต้มลูกค้า (customer.html)

หน้านี้คือ LIFF app ที่ลูกค้าเปิดผ่าน LINE เพื่อดูสถานะแต้มสะสม, แลกแก้วฟรี และดูประวัติการแลกรางวัล
Entry point: `client/customer.html` → `client/src/customer-main.jsx` → `client/src/pages/CustomerPortal.jsx`
สไตล์อยู่ใน `client/src/styles.css` (ส่วนท้ายไฟล์ หัวข้อ `Customer reward card (LIFF portal)`)

## แนวคิดหลัก

ออกแบบตามแพทเทิร์น "digital stamp card" ของแอปสะสมแต้มทั่วไป (การ์ดไล่เฉดสี + ตารางดวงตราปั๊ม + แท็บ
รางวัลที่ยังไม่ได้รับ/แลกแล้ว) แต่ปรับให้อยู่ในโทนสี **olive** เดิมของระบบ (theme `kopi-green`) แทนโทนม่วง
ของต้นแบบ และไม่ใช้พื้นการ์ดสีเข้มจัด — ใช้ไล่เฉดอ่อน ๆ + shadow เพื่อให้ดูมีมิติแทน

## โครงสร้างหน้า (Page anatomy)

ทุกอย่างอยู่ใน `.reward-page` (max-width 480px, กึ่งกลางจอ) เรียงจากบนลงล่างเป็น:

1. **Topbar** (`.reward-topbar`) — ชื่อหน้า "บัตรสะสมแต้ม" ซ้าย, ปุ่มปิด (`.reward-icon-btn`, ไอคอน ✕)
   ขวา — เรียก `liff.closeWindow()` ถ้าเปิดอยู่ใน LINE จริง
2. **Hero wordmark** (`.reward-hero`) — คำว่า "KOTEA" ตัวใหญ่ กึ่งกลาง เหนือการ์ด
3. **Reward card** (`.reward-card`) — การ์ดหลัก ดูหัวข้อ "Reward card" ด้านล่าง
4. **ปุ่มแลกแก้วฟรี** (`.btn.btn-primary.reward-redeem-btn`) — disabled ถ้ายังไม่มีแก้วฟรีให้แลก
5. **การ์ดโค้ด QR** (แสดงชั่วคราวหลังกดแลก) — ใช้ `.card` เดิมของระบบ ไม่มีคลาสใหม่
6. **แท็บ** (`.page-tabs.reward-tabs` + `.page-tab`) — "รางวัลที่ยังไม่ได้รับ" / "รางวัลที่แลกแล้ว"
7. **รายการรางวัล** (`.reward-list` + `.reward-list-item`) — เนื้อหาเปลี่ยนตามแท็บที่เลือก
8. **ประวัติล่าสุด** — ตาราง `.card` + `table.data` เดิมของระบบ (ไม่ได้ออกแบบใหม่)

### Reward card (`.reward-card`)

```
┌───────────────────────────────────────┐
│  สวัสดี                        (initials)│  ← .reward-card-top
│  ชื่อลูกค้า                      ⬤       │
│                                         │
│              KOTEA House               │  ← .store-name
│            ไม่มีวันหมดอายุ                │  ← .expiry
│           ซื้อครบ 10 แถม 1              │  ← .headline
│                                         │
│   [★ รางวัล]  อีก 4 ดวงถึงรางวัล         │  ← .reward-badge-row
│                                         │
│   ●  ●  ●  ●  ●                        │  ← .stamp-grid (5 คอลัมน์)
│   6  7  8  9  ★                        │     ดวงสุดท้าย = .reward-slot
└───────────────────────────────────────┘
```

- มุมซ้ายบนของการ์ด: ทักทายด้วยชื่อลูกค้าจริง (`customer.name` จาก `/api/customer/me`)
- มุมขวาบน: วงกลมอวาตาร์แสดง **ชื่อย่อ** ของลูกค้า (ไม่ใช้ไอคอนโลโก้แก้วกาแฟแล้ว) — คำนวณจากฟังก์ชัน
  `initials(name)` ใน `CustomerPortal.jsx` (เอาตัวแรกของคำแรก+คำที่สอง หรือ 2 ตัวแรกถ้ามีคำเดียว)
- ดวงตรา (`stamp`) ทั้งหมด = `promotion.buy_qty` ดวง, ดวงที่ถูกปั๊มแล้ว = `loyalty.purchased % buy_qty`
  ดวงสุดท้ายมีคลาส `.reward-slot` (เส้นขอบประ) แทนสัญลักษณ์ "รางวัลฟรี" ของรอบนั้น

## Design tokens ที่ใช้

ใช้ CSS custom properties ชุดเดิมของระบบทั้งหมด (`client/src/styles.css:10-47`, theme `kopi-green`)
ไม่มีการเพิ่มสีใหม่ ยกเว้นอ้างอิง `--gold` (มีอยู่แล้วใน `:root`) สำหรับดวงตรารางวัลตอนถูกปั๊ม

| Token | ใช้ที่ไหน |
|---|---|
| `--olive-50` / `--surface-color` / `--olive-100` | พื้นการ์ด ไล่เฉด `linear-gradient(160deg, olive-50 → surface-color 45% → olive-100)` — ไล่สีแค่นิดเดียว ไม่เข้มจัด |
| `--olive-500` → `--olive-700` | อวาตาร์initials และดวงตราที่ปั๊มแล้ว (`.stamp.filled`) ไล่เฉด `155deg` |
| `--highlight-color`, `--gold` | ดวงตรารางวัลสุดท้าย (`.reward-slot.filled`) |
| `--sage-500` | พื้นหลังป้าย "★ รางวัล" |
| `--text-color`, `--text-secondary`, `--text-muted` | ข้อความในการ์ด (เดิมเป็นสีขาวเพราะพื้นเข้ม ตอนนี้พื้นอ่อนแล้วเปลี่ยนกลับมาใช้สีตัวหนังสือปกติของระบบ) |
| `--shadow-sm` / `--shadow-md` / `--shadow-lg` | ทุกชั้นของการ์ด: ตัวการ์ดหลัก (`shadow-lg` + inset highlight), อวาตาร์ (`shadow-md`), ดวงตรา/ป้ายรางวัล/การ์ดรายการ (`shadow-sm`) — เพิ่มเข้ามาเพื่อให้ดูมีมิติ ไม่แบนราบ |
| `--radius-lg` / `--radius-md` / `--radius-sm` | ขอบมนของการ์ด/รายการ/ปุ่ม ตามระบบเดิม |

## Typography

- ใช้ฟอนต์ **Kanit** (Google Fonts) แทนชุด Outfit/DM Sans เดิม
- โหลดผ่าน `<link>` ใน `client/customer.html:9` และ override ตัวแปร `--font-display`, `--font-body`
  ด้วย `:root { ... }` ใน `<style>` ของไฟล์เดียวกัน (`client/customer.html:11-15`)
- **ขอบเขตผลกระทบ:** เปลี่ยนเฉพาะหน้า customer เท่านั้น เพราะ `index.html` / `pos.html` / `expense.html`
  เป็นคนละ HTML document (แยก build entry ใน `vite.config.js`) แม้จะใช้ `styles.css` ไฟล์เดียวกัน
  ตัวแปร `--font-*` ที่ override ใน `:root` ของ `customer.html` จะไม่หลุดไปกระทบฝั่งสตาฟ

## States & data mapping

CustomerPortal มี 4 phase: `loading` → `register` (ถ้ายังไม่เคยลงทะเบียน) → `ready` / `error`
ดีไซน์ในเอกสารนี้ครอบคลุมเฉพาะหน้า **ready** (หน้าจอหลักหลังล็อกอินสำเร็จ)

| ข้อมูลจาก `/api/customer/me` | ใช้ที่ไหนในดีไซน์ |
|---|---|
| `customer.name` | ชื่อทักทายมุมซ้ายบนของการ์ด + ชื่อย่อในอวาตาร์ |
| `promotion.buy_qty` | จำนวนดวงตราทั้งหมดใน `.stamp-grid` |
| `loyalty.purchased % buy_qty` | จำนวนดวงตราที่ปั๊มแล้วในรอบปัจจุบัน (`inCycle`) |
| `loyalty.available` | ปุ่มแลกแก้วฟรีกดได้/ไม่ได้ + ข้อความในป้ายรางวัล + สถานะการ์ด "1 แก้วฟรี!" ในแท็บ "ยังไม่ได้รับ" |
| `loyalty.pending` | การ์ดเพิ่มเติมในแท็บ "ยังไม่ได้รับ": "โค้ดที่รอใช้ N รายการ" |
| `recentOrders.filter(is_free === '1')` | รายการในแท็บ "รางวัลที่แลกแล้ว" (ใช้ประวัติ 10 ออเดอร์ล่าสุด ไม่ได้ดึง endpoint ใหม่) |

ปุ่มแลกแก้วฟรีและป๊อปอัปโค้ด QR ใช้ flow เดิม (`doRedeem()`) ไม่ได้แก้ logic — แก้เฉพาะหน้าตา

## ไฟล์ที่เกี่ยวข้อง

- `client/customer.html` — โหลดฟอนต์ Kanit + override `--font-display`/`--font-body`
- `client/src/pages/CustomerPortal.jsx` — โครงสร้าง JSX ของหน้า ready state + ฟังก์ชัน `initials()`
- `client/src/styles.css` (ท้ายไฟล์) — คลาส `.reward-*` และ `.stamp*` ทั้งหมด

## ที่ยังไม่ได้ทำ / ข้อควรรู้

- ชื่อร้าน "KOTEA House" ยัง hardcode ไว้ในโค้ด เพราะ `/api/customer/me` ไม่ได้ส่ง `shop_name` กลับมา
  (มีอยู่แล้วใน `settings` ฝั่งสตาฟ แต่ endpoint ลูกค้ายังไม่ expose) — ถ้าต้องการให้ดึงจริงต้องแก้ backend
  (`server/index.js` route `/api/customer/me`) ให้ join ค่านี้เพิ่ม
- หน้า `loading` / `register` / `error` (ก่อนเข้า ready) ยังใช้สไตล์ `.card`/`.logo` เดิม ไม่ได้ปรับให้เข้าชุดนี้
