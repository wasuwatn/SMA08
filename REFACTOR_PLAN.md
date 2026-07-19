# Refactor Plan — SMA V08 (KOTEA)

**กติกาหลัก: ห้ามเกิดการเปลี่ยนแปลงใดๆ ที่ลูกค้ามองเห็น**
`customer.html` / Customer Portal (LIFF rewards) แก้โค้ดภายในได้ แต่หน้าตา, ข้อความ,
พฤติกรรม, และ API contract ที่ portal ใช้ ต้องเหมือนเดิม 100% — ทุก phase ด้านล่าง
เป็น *behavior-preserving refactor* เท่านั้น (ไม่เพิ่มฟีเจอร์ ไม่แก้บั๊ก ไม่เปลี่ยน UI)

## สภาพปัจจุบัน (จุดที่ควรแก้)

| ไฟล์ | ขนาด | ปัญหา |
|---|---|---|
| `server/index.js` | 1,535 บรรทัด | ทุก route รวมอยู่ไฟล์เดียว: auth, customer portal, points, checkout, shifts, delivery import, backup, generic CRUD |
| `client/src/pages/POS.jsx` | 970 บรรทัด | state ~30 ตัวในคอมโพเนนต์เดียว (cart, customizer, payment, shift, history, loyalty) |
| `client/src/pages/CustomerPortal.jsx` | 690 บรรทัด | icons/SVG, claim-token utils, และ UI ทุก tab อยู่ไฟล์เดียว **(customer-facing — แตะเป็นลำดับสุดท้าย)** |
| `server/db.js` | 778 บรรทัด | schema/migration + query helpers + auth hashing ปนกัน |
| `client/src/pages/Recipes.jsx` | 493 บรรทัด | หลาย modal/ตารางในไฟล์เดียว |
| `client/src/lib/helpers.js` | 245 บรรทัด | ปนกันระหว่าง formatting, BOM math, CSV, delivery parsing, modifier categories |

## Phase 0 — Safety net (ทำก่อนแตะโค้ด)

เพราะ repo ไม่มี test suite เลย ตัวตรวจว่า "ลูกค้าไม่เห็นความเปลี่ยนแปลง" คือ build output:

1. Snapshot baseline: `npm run build` และ `npm run build:customer` เก็บผลไว้เปรียบเทียบ
   (โดยเฉพาะ `client/dist-customer/` — bundle ของฝั่งลูกค้า)
2. บันทึกรายการ API endpoint ที่ Customer Portal เรียก (จาก `lib/customerApi.js` +
   `/api/customer/*`, `/api/ping`) — เส้นเหล่านี้ **ห้ามเปลี่ยน path, payload, response shape**
3. หลังทุก phase: build ต้องผ่าน + smoke test เปิด Mother/POS/Expense/Customer ใน dev
   (`npm run dev`) เทียบพฤติกรรมกับ baseline

## Phase 1 — แตก `server/index.js` เป็น route modules (เสี่ยงต่ำ, ได้ผลมาก)

ไฟล์นี้มี section comment แบ่งไว้ชัดเจนอยู่แล้ว — แตกตาม section เดิมเป็น
`server/routes/*.js` โดยแต่ละไฟล์ export ฟังก์ชัน `register<X>Routes(app, deps)`
ตามแบบแผนที่ `lineExpense.js` ใช้อยู่แล้ว:

- `routes/auth.js` — login, pin-login, staff-list, change-password, set-pin
- `routes/customerPortal.js` — `/api/customer/*` **(ย้ายโค้ดเฉยๆ ห้ามแก้ logic แม้แต่บรรทัดเดียว)**
- `routes/lineSlips.js` — `/api/line/slips*` (Make.com flow)
- `routes/points.js` — `/api/points/*`, `/api/redemption/*`
- `routes/checkout.js` — `/api/checkout/*`, void, claim code
- `routes/shifts.js` — `/api/shift/*`
- `routes/delivery.js` — `/api/import/delivery`
- `routes/adminOps.js` — backup/restore
- `routes/crud.js` — generic `/api/:table` (mount ท้ายสุดเหมือนเดิม — ลำดับ mount สำคัญ ต้องคงไว้)
- helpers ที่ route ใช้ร่วมกัน (`fail`, `actor`, `isAdmin`, `canWrite`, `forbidden`, auth middleware) → `routes/shared.js`

`index.js` เหลือแค่ bootstrap: env checks, middleware (helmet/cors/json/rate-limit),
static serving, แล้วเรียก register ทีละ module **ตามลำดับเดิม**

## Phase 2 — แตก state ใน `POS.jsx` เป็น custom hooks (หลังร้าน, ลูกค้าไม่เห็น)

คอมโพเนนต์ modal แยกไว้แล้ว (`components/pos/`) แต่ state ยังกองรวม — แยกเป็น hooks
ใน `client/src/hooks/pos/`:

- `useCart()` — cart lines, discounts, promo/redeem code, ยอดรวม
- `useCustomizer()` — selected drink, qty, child, sweetness, container, addons
- `useShift()` — shift modal, cash, Z-report
- `usePayment()` — pay method, cash received, PromptPay QR generation
- `useRecentSales()` — history window fetch/refresh

`POS.jsx` เหลือหน้าที่ประกอบ hooks + render ผลลัพธ์/props ต้องเท่าเดิมทุกตัว

## Phase 3 — จัดระเบียบ `helpers.js` (ใช้ร่วมทุกแอป — ระวังเป็นพิเศษ)

แตกเป็นโมดูลตามหน้าที่ โดย **คง `helpers.js` เดิมไว้เป็น re-export barrel** เพื่อไม่ต้อง
แก้ import ทั้งโปรเจกต์ในคราวเดียว (และไม่เสี่ยง import พลาด):

- `lib/format.js` — `money`, `today`, `csvEscape`, `downloadFile`, `nextSeqId`, `getYearFromDate`
- `lib/bom.js` — `computeRequirements`, `computeCupCost`, `expandSetItems`
- `lib/deliveryImport.js` — `parseOrderCups`, `splitComboName`, `decomposeDeliveryMenu`, `DELIVERY_HEADER_ALIASES`, `parseCSVLine`
- `lib/modifiers.js` — modcat/modopt helpers, `parseModifierCategories`, `MANDATORY_MODIFIER_NAMES`
- คงไว้ใน `helpers.js`: `TABLES`, `HEAVY_TABLES`, `THEMES`, `claimUrl`, `parseDiscount`, ค่าคงที่อื่น

หมายเหตุ: `claimUrl` ผูกกับ LIFF deep-link ของลูกค้า — ย้าย/ห่อได้ แต่ URL ที่ผลิตออกมาต้องเท่าเดิม

## Phase 4 — แตก `server/db.js`

- `server/schema.js` — DDL + `migrate()` + seed (ห้ามแก้ SQL ใดๆ — โครงสร้าง DB คงเดิม)
- `server/queries.js` — `listRows/insertRow/updateRow/deleteRow/getRow`, `TABLE_CONFIG`
- `server/authUtils.js` — `hashPassword/verifyPassword/verifyPin`
- `db.js` เดิมเหลือ pool + re-export ทุกอย่าง (server code อื่น import ต่อได้ไม่ต้องแก้)

## Phase 5 — `CustomerPortal.jsx` (customer-facing — ทำท้ายสุด, ขอบเขตแคบสุด)

อนุญาตเฉพาะการย้ายโค้ดแบบกลไกล้วน (mechanical move) ที่พิสูจน์ได้ว่า output เท่าเดิม:

- ย้าย SVG icon components (`CupArt`, `Scallop`, `Sparkle`, `GiftIcon`, ...) →
  `components/customer/icons.jsx` — JSX เดิมทุก attribute
- ย้าย claim-token utils (`stashClaimToken`, `extractClaimToken`, `CLAIM_KEY`) →
  `lib/claimToken.js`
- ย้าย label constants (`COUPON_LABEL`, `POINTS_LABEL`) ไปไฟล์เดียวกับที่ใช้ — **ห้ามแก้ข้อความแม้แต่ตัวอักษรเดียว**

**ไม่ทำ** ใน portal: ไม่แตก tab เป็นคอมโพเนนต์ย่อย, ไม่แตะ `customer.css`,
ไม่แตะ `customer.html` (ไม่มีอะไรต้องแก้ในนั้นอยู่แล้ว), ไม่แตะลำดับ hook/effect
(bootstrap, ping keep-alive, claim flow) — ความเสี่ยงไม่คุ้มกับประโยชน์

ตรวจรับ phase นี้: `npm run build:customer` แล้วเทียบหน้าจอทุก phase
(loading / register / ready ทั้ง 3 แท็บ / claim success / claim error) กับ baseline ต้องตรงกันทุกพิกเซล

## สิ่งที่ *ไม่* อยู่ในแผนนี้ (จงใจไม่ทำ)

- เปลี่ยน API path/shape ใดๆ — satellite เก่าและ coffee-pos-buddy พึ่ง contract เดิม
- DB migration / เปลี่ยน schema
- เปลี่ยน dependency, อัปเกรด lib, เปลี่ยน build config
- แก้ UI/UX, ข้อความ, สี, layout ของทุกแอป (ไม่ใช่แค่ฝั่งลูกค้า — refactor นี้ pure structure)
- แก้บั๊กที่เจอระหว่างทาง → จดใส่ issue แยก ไม่ปนใน refactor commit

## ลำดับทำ + การตรวจรับ

ทำทีละ phase, phase ละ 1 PR/commit ชุด, ตามลำดับ 0 → 1 → 2 → 3 → 4 → 5
(เรียงจากเสี่ยงน้อย→มาก; ฝั่งลูกค้าอยู่ท้ายสุดและตัดทิ้งได้ทั้ง phase ถ้าไม่สบายใจ)
ทุก phase ปิดงานด้วย: build ทั้ง 3 target ผ่าน + smoke test 4 แอป + ยืนยันว่า
`dist-customer` behavior ไม่เปลี่ยน
