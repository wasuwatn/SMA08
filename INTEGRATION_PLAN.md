# 🔗 Integration Plan — LINE Expense Automation + POS ใหม่ (coffee-pos-buddy)

แผนการเชื่อมระบบใหม่ 2 ระบบเข้ากับ SMA08 (hub เดิม) โดยยึดหลักเดียวกันทั้งแผน:

> **hub API + ฐานข้อมูลเดิมเป็น source of truth เพียงที่เดียว** —
> ระบบใหม่ทุกตัวเป็น "satellite" ที่คุยกับ hub เหมือน POS/Expense เดิม
> ไม่มีการสร้างฐานข้อมูลที่สอง ไม่มี sync bridge

```
Supabase Postgres ── Express hub API (JWT, idempotent writes)
                          │
   ┌──────────┬───────────┼────────────────┬──────────────────┐
 Mother     POS เดิม    Expense เดิม   [ใหม่] LIFF สลิป    [ใหม่] POS iPhone
 (คงเดิม)   (คงไว้จน    (คงเดิม)      LINE x Make.com     (UI จาก coffee-
             cutover)                                       pos-buddy)
```

---

## สรุปผลวิเคราะห์ความเข้ากันได้

### ระบบ 1 — LINE Expense (Make.com blueprint)

เข้ากันได้สูง แต่ blueprint ตามเอกสารต้นทาง **ยังไม่จบวงจร** — ต้องปรับ 4 จุด:

| # | ปัญหาใน blueprint เดิม | ผลกระทบ | ทางแก้ในแผนนี้ |
|---|---|---|---|
| 1 | Flow จบที่ `pending_slips.status='completed'` ไม่เขียนลงตาราง `expenses` | รายจ่ายไม่เข้า Dashboard, ไม่ restock สต๊อก | ขั้น confirm ผ่าน hub → insert `expenses` (+ restock) ใน transaction |
| 2 | RLS `USING (true)` + anon key ฝังในหน้า LIFF | ใครก็อ่าน/แก้สลิปทุกใบได้ | ตัด anon key ทิ้ง — ทุก request ผ่าน hub (secret สำหรับ Make, one-time token สำหรับ LIFF) |
| 3 | ไม่มี idempotency | Make retry = สลิปซ้ำ | ใช้ LINE `message.id` เป็น unique key |
| 4 | หมวดหมู่ hardcode ไม่ตรงกับ `expenses.category` เดิม | ข้อมูลไม่ consistent | LIFF ดึงหมวดหมู่/รายชื่อ buyer จริงจาก hub |

ข้อได้เปรียบ: SMA08 มี Supabase Postgres, ตาราง `customers.line_user_id`,
หน้า LIFF (customer portal) และ pattern การ deploy LIFF บน Vercel อยู่แล้ว → reuse ได้เกือบหมด

### ระบบ 2 — coffee-pos-buddy (POS ใหม่สำหรับ iPhone)

**ตัดสินใจแล้ว: ทางเลือก A** — เก็บ UI/UX ของ coffee-pos-buddy ไว้ทั้งหมด
แต่ถอด backend (Supabase Auth + Supabase project ของ Lovable) ออก
แล้วเสียบ hub API ของ SMA08 เข้าไปแทน

เหตุผล: backend ของ coffee-pos-buddy ขาดฟีเจอร์หลักที่ธุรกิจใช้อยู่ทุกวัน
และการรันสองฐานข้อมูลคู่กันทำให้ยอดขายแตกเป็นสองโลก

| ความสามารถ | SMA08 hub | coffee-pos-buddy | หลัง integrate (A) |
|---|---|---|---|
| ตัดสต๊อกตาม BOM | ✅ | ❌ | ✅ (hub จัดการ) |
| กะเงินสด + Z-report | ✅ | ❌ | ✅ (hub จัดการ) |
| แต้มสะสม / แลกฟรี | ✅ | ❌ | ✅ (hub จัดการ) |
| PromptPay QR | ✅ | ❌ (มีแค่ cash/transfer และ hardcode `"cash"`) | ✅ (port `promptpay.js`) |
| Offline-first | ✅ (outbox) | ❌ | ✅ (port `outbox.js` — เฟสท้าย) |
| กันบันทึกซ้ำ | ✅ `client_txn_id` | ❌ | ✅ |
| UI สำหรับ iPhone | ⚠️ พอใช้ | ✅ ดีมาก (safe-area, bottom nav, modifier UX) | ✅ |
| ข้อมูลรวมใน Dashboard | ✅ | ❌ (คนละ DB) | ✅ |

---

## Phase 1 — LINE Expense Automation

> **ทำก่อน** — งานเล็กกว่า จบใน repo นี้ที่เดียว เห็นผลเร็ว ไม่พึ่ง Phase 2

### สถาปัตยกรรม

```
[LINE OA] ผู้ใช้ส่งรูปสลิป
   → [Make.com] webhook → ดึงรูปจาก LINE → OCR (เช่น SlipOk)
   → POST /api/line/slips                (hub, header: X-Line-Webhook-Secret)
       hub เก็บลง pending_slips, คืน { id, confirm_token }
   → [Make.com] ส่ง Flex Message (ปุ่มเปิด LIFF ?id=…&token=…)
[LIFF expense-review.html] ผู้ใช้ตรวจ/แก้/เลือกหมวด+buyer (+วัตถุดิบ restock)
   → GET  /api/line/slips/:id?token=…    (โหลดข้อมูลเข้าฟอร์ม)
   → POST /api/line/slips/:id/confirm    (token เดิม)
       hub: transaction → insert expenses (+ stocklog/restock) → status='completed'
   → liff.sendMessages("✅ บันทึกสำเร็จ") → liff.closeWindow()
```

### 1.1 Database — เพิ่มตารางใน `server/db.js` (`TABLE_CONFIG`)

```sql
CREATE TABLE IF NOT EXISTS pending_slips (
  id SERIAL PRIMARY KEY,
  line_message_id TEXT UNIQUE,      -- idempotency: Make retry ไม่สร้างแถวซ้ำ
  line_user_id    TEXT,             -- map → customers/users เพื่อเดา buyer
  amount          DOUBLE PRECISION DEFAULT 0,
  merchant        TEXT,
  category        TEXT,
  slip_image_url  TEXT,
  ocr_raw         TEXT,             -- payload OCR ดิบ ไว้ debug
  status          TEXT DEFAULT 'pending',   -- pending | completed | discarded
  confirm_token   TEXT,             -- one-time token ผูกกับปุ่มใน Flex Message
  expense_id      INTEGER,          -- FK กลับไป expenses หลัง confirm
  created_at      TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ
)
```

หมายเหตุ: ใช้ pattern เดียวกับตารางอื่นใน `TABLE_CONFIG` — `migrate()` จะเพิ่มตาราง/คอลัมน์ที่หายไปให้เองตอน hub start

### 1.2 Hub API — 3 endpoints ใหม่ใน `server/index.js`

วางไว้ก่อน JWT middleware (`app.use('/api', …)`) เหมือนกลุ่ม `/api/customer/*` เพราะผู้เรียกไม่มี JWT:

| Endpoint | ผู้เรียก | Auth | หน้าที่ |
|---|---|---|---|
| `POST /api/line/slips` | Make.com | header `X-Line-Webhook-Secret` เทียบ env `LINE_SLIP_SECRET` | upsert ด้วย `line_message_id` (ON CONFLICT DO NOTHING → คืนแถวเดิม), gen `confirm_token` (crypto random 32 bytes), คืน `{ id, confirm_token }` |
| `GET /api/line/slips/:id` | หน้า LIFF | query `?token=` ต้องตรงกับ `confirm_token` และ `status='pending'` | คืนข้อมูลสลิป + ตัวเลือกประกอบฟอร์ม: หมวดหมู่ (distinct จาก `expenses.category`), รายชื่อ buyer (จาก `settings.buyers`), รายการ `materials` (id, name, unit) สำหรับ restock |
| `POST /api/line/slips/:id/confirm` | หน้า LIFF | token เดิมใน body | ดูรายละเอียดล่าง |

**Confirm — ทำใน `withTransaction` เดียว (reuse pattern ของ `POST /api/expense` เดิม):**

1. `UPDATE pending_slips SET status='completed' WHERE id=$1 AND confirm_token=$2 AND status='pending' RETURNING *`
   — atomic claim แบบเดียวกับ `redemptions` ใน `runCheckout()`: กดซ้ำ/ยิงซ้ำ = 409 ไม่เกิด expense ซ้ำ
2. `insertRow('expenses', { date, description: merchant, amount, buyer, category, mat_barcode?, qty?, unit?, price?, note: 'LINE slip #<id>' })`
3. ถ้าผู้ใช้ผูกวัตถุดิบ: `adjustStock(material_id, +increment)` + `insertRow('stocklog', { action: 'Replenishment', note: 'LINE slip …' })`
4. อัปเดต `pending_slips.expense_id`, `confirmed_at`
5. `logActivity('line-slip', 'EXPENSE', …)`

**Env ใหม่ (server/.env):** `LINE_SLIP_SECRET=<random>`

### 1.3 หน้า LIFF ใหม่ — `client/expense-review.html`

- Entry point ใหม่ใน client เดิม (pattern เดียวกับ `customer.html`):
  สร้าง `client/src/expense-review.jsx` + เพิ่ม input ใน vite config
  และทำ `vite.expense-review.config.js` + สคริปต์ `build:expense-review`
  ตามแบบ `vite.customer.config.js` / `build:customer` เพื่อ deploy แยกบน Vercel ได้
- ฟอร์ม: ร้านค้า/รายการ, ยอดเงิน, หมวดหมู่ (dropdown จาก hub), buyer (dropdown จาก hub),
  ส่วนพับได้ "เติมสต๊อกจากบิลนี้" → เลือกวัตถุดิบ + จำนวน (optional)
- แสดงรูปสลิป (`slip_image_url`) ประกอบการตรวจ
- Env build-time: `VITE_API_BASE`, `VITE_EXPENSE_LIFF_ID`
- หลัง confirm สำเร็จ: `liff.sendMessages()` ข้อความสรุป แล้ว `liff.closeWindow()`
- เพิ่ม route `app.get('/expense-review.html', …)` ใน hub เป็น fallback dev เหมือน `customer.html`
- **ไม่มี Supabase key ใด ๆ ในหน้านี้** — คุยกับ hub เท่านั้น

### 1.4 Make.com scenario

ตาม blueprint เดิมทุก module ยกเว้น:

- **Module 4** เปลี่ยนจาก Supabase REST → `POST https://<hub>/api/line/slips`
  - Headers: `X-Line-Webhook-Secret: <LINE_SLIP_SECRET>`, `Content-Type: application/json`
  - Body: `{ "line_message_id": "{{1.events[].message.id}}", "line_user_id": "{{1.events[].source.userId}}", "amount": {{ยอดจาก OCR}}, "merchant": "{{ร้านจาก OCR}}", "slip_image_url": "…", "ocr_raw": "{{payload OCR}}" }`
- **Module 5 (Flex Message)** ปุ่ม uri:
  `https://liff.line.me/<EXPENSE_LIFF_ID>?id={{4.body.id}}&token={{4.body.confirm_token}}`

### 1.5 LINE Developers

- ใช้ Messaging API channel ตาม blueprint (webhook → Make.com)
- สร้าง **LIFF app ใหม่แยกจาก customer portal** (คนใช้เป็นทีมงานร้าน ไม่ใช่ลูกค้า)
  — Endpoint URL ชี้ Vercel deployment ของ `expense-review.html`, scope: `profile`, `chat_message.write`
- เพิ่ม domain Vercel ใหม่เข้า `CORS_ORIGIN` ของ hub

### 1.6 Definition of done (Phase 1)

- [ ] ส่งรูปสลิปใน LINE → ได้ Flex Message กลับภายในไม่กี่วินาที
- [ ] กดปุ่ม → LIFF เปิด ฟอร์ม prefill จาก OCR, dropdown มาจากข้อมูลจริง
- [ ] กดยืนยัน → แถวใหม่ใน `expenses` โผล่ใน Mother/ExpenseLog ทันที
- [ ] เลือกวัตถุดิบ → `materials.current_stock` เพิ่ม + มีแถว `stocklog`
- [ ] ยิง webhook ซ้ำ (message id เดิม) → ไม่เกิดสลิปซ้ำ
- [ ] กดยืนยันซ้ำ / token ผิด → 409/403 ไม่เกิด expense ซ้ำ
- [ ] เปิด URL LIFF โดยไม่มี token → อ่านข้อมูลไม่ได้

---

## Phase 2 — POS ใหม่ (coffee-pos-buddy UI + SMA08 hub)

> ตัดสินใจแล้ว: **ทางเลือก A** — coffee-pos-buddy กลายเป็น frontend ของ hub
> งานส่วนใหญ่อยู่ใน repo `coffee-pos-buddy`; ฝั่ง SMA08 hub **แทบไม่ต้องแก้อะไร**
> เพราะ contract ที่ POS เดิมใช้ (`/api/auth/login`, `/api/checkout/pos`, `/api/shift/*`)
> รองรับอยู่แล้ว

### 2.1 ถอด Supabase, เสียบ hub API (repo: coffee-pos-buddy)

- แทนที่ `src/integrations/supabase/*` ด้วย API client ใหม่ (`src/integrations/hub/client.ts`)
  — พอร์ตจาก `client/src/lib/api.js` ของ SMA08: base URL จาก `VITE_API_BASE`,
  แนบ `Authorization: Bearer <JWT>`, จัดการ 401 → เด้งกลับหน้า login
- หน้า `auth.tsx`: เปลี่ยนจาก Supabase Auth → `POST /api/auth/login` (username/password)
  เก็บ token + user (role, access) ใน localStorage แบบเดียวกับ POS เดิม
  - รองรับ flow "default password ต้องเปลี่ยนก่อนใช้" (`/api/auth/change-password`)
  - Guard: user ต้องมี access flag `pos`
- ลบ `supabase/` migrations และ dependency `@supabase/supabase-js` เมื่อไม่มีจุดเรียกเหลือ
- ตาราง `orders/order_items/products/…` ใน Supabase ของ Lovable = ทิ้ง (ไม่มีข้อมูลจริงที่ต้อง migrate — ถ้ามีข้อมูลทดลองขายอยู่ ให้ export CSV เก็บไว้ก่อน)

### 2.2 Catalog adapter — map ข้อมูล hub → รูปที่ UI ใช้

โหลดครั้งเดียวตอนเปิดแอป (แล้ว cache) จาก hub:

| hub (SMA08) | → UI coffee-pos-buddy |
|---|---|
| `menuname` (id `MN…`, name, category, front_price, status) | `products` (ใช้ id เดิมเป็น string, กรอง status Active) |
| `menuname.category` (distinct) | `categories` |
| `childmenu` (variant ของเมนู + price_change) | modifier group "สูตร/ขนาด" per product (required, เลือก 1) |
| `settings.sweetness_levels` | modifier group "ความหวาน" (required, เลือก 1) |
| `addons` (name, price_change) | modifier group "ท็อปปิ้ง" (optional, หลายรายการ) |
| container (Hot/Iced ตาม POS เดิม) | modifier group "แก้ว" |
| `settings` (shop_name, promptpay_id, receipt_footer, logo) | หน้า settings/receipt |

> UI modifier ของ coffee-pos-buddy รองรับโครงนี้อยู่แล้ว (`modifier_groups` + required/max_selections) — เปลี่ยนเฉพาะแหล่งข้อมูล

ข้อมูลที่ต้องโหลดเพิ่มสำหรับ checkout: `bom`, `packagingbom`, `matprepbom`, `childmenu`
(ใช้คำนวณ requirements — ดู 2.3)

### 2.3 Checkout — payload ต้องเทียบเท่า POS เดิมทุกฟิลด์

พอร์ต `computeRequirements()` จาก `client/src/lib/helpers.js` (SMA08) ไปเป็น TS
แล้วยิง `POST /api/checkout/pos`:

```jsonc
{
  "client_txn_id": "<uuid ต่อบิล — กันซ้ำตอน retry>",
  "date": "YYYY-MM-DD",
  "sales": [           // 1 แถวต่อแก้ว (ไม่ใช่ต่อรายการ) — สำคัญ!
    {
      "customer_name": "…หรือ Walk-in",
      "payment_method": "Cash | PromptPay | Transfer",
      "shift_id": "<id กะที่เปิดอยู่>",
      "order_type": "Front", "menu_name": "…", "variant": "…",
      "quantity": 1, "sweetness": "…", "container": "…",
      "addons": "<JSON string>", "addon_price": 0,
      "total_price": 55, "cashier": "<username>",
      "is_free": "0", "promotion_id": ""
    }
  ],
  "requirements": [ { "material_id": "MAT…", "qty": 12, "note": "Front POS: …" } ],
  "expense": null,        // ต้นทุนแก้วฟรี (เฟสแต้ม)
  "redemption_id": null   // โค้ดแลกฟรี (เฟสแต้ม)
}
```

จุดที่ต้องแก้ใน UI เดิมของ coffee-pos-buddy:

- `checkout.tsx` ตอนนี้ **hardcode `paymentMethod: "cash"`** และมี `MethodBtn` ที่ไม่ได้ใช้
  → ทำ 3 ปุ่มจริง: เงินสด (รับเงิน/เงินทอน) / PromptPay / โอน
- PromptPay: พอร์ต `client/src/lib/promptpay.js` (สร้าง QR จาก `settings.promptpay_id`)
  แสดง QR ตอนเลือกจ่ายแบบ PromptPay
- Error handling ตาม hub: 409 `INSUFFICIENT_STOCK` → แจ้งวัตถุดิบที่ขาด,
  409 อื่น ๆ ตาม `/api/checkout/pos`
- ใบเสร็จ: หน้า receipt เดิมของ coffee-pos-buddy ใช้ต่อได้ แต่เติมข้อมูลร้านจาก `settings`
  + เลข `order_no` ที่ hub คืนมา (print 58มม. ผ่าน browser dialog แบบ POS เดิม)

### 2.4 กะเงินสด (Shifts) — ฟีเจอร์ใหม่ใน UI

- ก่อนขายต้องมีกะเปิด: `GET /api/shift/current` — ถ้า null ให้บังคับหน้า "เปิดกะ" (นับเงินตั้งต้น → `POST /api/shift/open`)
- ปุ่มปิดกะใน settings/bottom nav: `POST /api/shift/close` → แสดง Z-report (ยอดตาม payment method, expected vs counted) + print
- ทุกบิล stamp `shift_id` (2.3)

### 2.5 Offline-first (เฟสท้ายของ Phase 2 — เปิดใช้งานจริงได้ก่อนโดยไม่มีข้อนี้)

- พอร์ต `client/src/lib/outbox.js` (queue ใน localStorage + flush เมื่อ online กลับ)
  — hub dedup ด้วย `client_txn_id` อยู่แล้ว retry ปลอดภัย
- Cache catalog ใน localStorage + service worker (PWA installable บน iPhone:
  manifest + apple-touch-icon — TanStack Start ทำ PWA ได้ผ่าน vite plugin)
- ขายออฟไลน์ = ยิงด้วย `force: true` ตอน flush (ตาม convention ของ `runCheckout`)

### 2.6 ระบบแต้ม/แลกฟรี (optional — ทำหลังขายจริงได้เสถียร)

- ช่องกรอกโค้ดแลกฟรี: `GET /api/redemption/:code` → แนบ `redemption_id` + mark แก้วฟรี
- แก้วฟรี: `is_free='1'` + `promotion_id` + แนบ `expense` ต้นทุน BOM (ดู `POS.jsx:483` เป็นต้นแบบ)

### 2.7 Deploy & cutover

> อัปเดต: coffee-pos-buddy build ด้วย TanStack Start nitro ซึ่ง default ไปที่
> Cloudflare Workers — ตอนนี้ pin ไว้ที่ preset `vercel` แล้ว (`nitro: { preset:
> "vercel" }` ใน `vite.config.ts`) ให้ตรงกับ static host ที่ร่างไว้ตอนแรกและ
> เข้าชุดเดียวกับ LIFF pages ของ repo นี้ — ขั้นตอน build/deploy ละเอียดอยู่ใน
> `README.md` ของ repo นั้นแล้ว (`bun run build` → `npx vercel deploy
> --prebuilt --prod`, หรือผูก GitHub repo เข้ากับ Vercel project ให้ deploy
> อัตโนมัติทุก push)

1. ✅ Build + deploy ด้วย `VITE_API_BASE=https://<hub>` (baked ตอน build) — ดู coffee-pos-buddy/README.md
2. เพิ่ม origin ที่ deploy ได้ใน `CORS_ORIGIN` ของ hub แล้ว restart hub — **ต้องทำมือ** (ยังไม่มี hub จริง deploy อยู่ให้ชี้)
3. **รันคู่กับ `pos.html` เดิม** — ทั้งคู่เขียนผ่าน endpoint เดียวกัน ข้อมูลไม่ชนกัน
   (ระวังอย่างเดียว: อย่าเปิด 2 กะพร้อมกัน — hub บังคับกะเดียวอยู่แล้ว)
4. ใช้จริงบน iPhone อย่างน้อย 1–2 สัปดาห์ → เทียบ Z-report กับของเดิม — **ต้องใช้เวลา/อุปกรณ์จริง ทำมือ**
   (checklist ละเอียดอยู่ใน coffee-pos-buddy/README.md ส่วน "Cutover from pos.html")
5. เสถียรแล้วค่อยเลิกใช้ `pos.html` (เก็บโค้ดไว้ก่อน ยังไม่ลบ)

### 2.8 Definition of done (Phase 2)

- [ ] Login ด้วย user ของ hub (access flag `pos`) + บังคับเปลี่ยนรหัส default
- [ ] เมนู/หมวด/ความหวาน/ท็อปปิ้ง/variant มาจาก hub ครบ ราคาตรงกับ POS เดิม
- [ ] ขาย 1 บิลหลายแก้ว → `salefront` ได้ 1 แถว/แก้ว, `order_no` เดียวกัน, สต๊อกถูกตัดตาม BOM
- [ ] จ่ายได้ครบ 3 แบบ, PromptPay แสดง QR ถูกต้อง
- [ ] เปิด/ปิดกะได้, Z-report ตรงกับยอดขายจริง
- [ ] ยอดขายโผล่ใน Mother Dashboard/SalesLog ทันที
- [ ] ยิงบิลซ้ำ (txn id เดิม) → ไม่เกิดแถวซ้ำ
- [ ] (เฟสท้าย) ปิด network ขาย 2-3 บิล → กลับ online แล้ว sync ครบไม่ซ้ำ

---

## ลำดับงานรวม

| ลำดับ | งาน | Repo | ขนาด |
|---|---|---|---|
| 1 | Phase 1.1–1.2: ตาราง + hub endpoints | SMA08 | S |
| 2 | Phase 1.3: หน้า LIFF expense-review | SMA08 | M |
| 3 | Phase 1.4–1.5: Make.com + LINE setup | (นอก repo) | S |
| 4 | Phase 2.1: auth + hub client | coffee-pos-buddy | M |
| 5 | Phase 2.2–2.3: catalog adapter + checkout | coffee-pos-buddy | L |
| 6 | Phase 2.4: shifts + PromptPay + receipt | coffee-pos-buddy | M |
| 7 | Phase 2.7: deploy คู่ + ทดลองใช้จริง | ทั้งสอง | S |
| 8 | Phase 2.5: offline/PWA | coffee-pos-buddy | M |
| 9 | Phase 2.6: แต้ม/แลกฟรี | coffee-pos-buddy | M |

หลักการตัดสินใจระหว่างทาง: ถ้าฟีเจอร์ไหนทำให้ต้องแก้ contract ของ hub
ให้เลือกแก้ฝั่ง client ก่อนเสมอ — hub เดิมมี POS/Expense เดิมพึ่งพาอยู่จน cutover เสร็จ
