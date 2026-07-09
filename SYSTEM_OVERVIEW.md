# สรุประบบทั้งหมด — KOTEA (SMA V08) + ระบบรอบข้าง

> อัปเดตล่าสุด: 2026-07-09 · เอกสารนี้สรุปภาพรวมทุกส่วนของระบบ ทั้ง repo นี้ (SMA08)
> และ repo ข้างเคียง (coffee-pos-buddy) รวมถึงระบบอัตโนมัติผ่าน LINE/Make.com
> รายละเอียดเชิงลึกดูเพิ่มได้ที่ [README.md](README.md) และ [INTEGRATION_PLAN.md](INTEGRATION_PLAN.md)

---

## 1. สถาปัตยกรรมภาพรวม (Hub-and-Spoke)

ทุกอย่างวิ่งเข้า **hub ตัวเดียว** — Express API + Postgres (โฮสต์บน Supabase)
เป็นแหล่งข้อมูลจริงเพียงที่เดียว (single source of truth) แอปทุกตัวเป็น "ดาวบริวาร"
ที่คุยกับ hub ผ่าน REST API เท่านั้น ไม่มีแอปไหนต่อ database ตรง

```
                        ┌─────────────────────────────┐
                        │   HUB (server/index.js)     │
                        │   Express API on Render      │
                        │   Postgres on Supabase       │
                        └──────────────┬──────────────┘
           ┌───────────┬───────────┬───┴───────┬────────────┬─────────────┐
           │           │           │           │            │             │
      Mother App   pos.html   expense.html  customer.html  expense-    coffee-pos-
      (หลังบ้าน)  (POS desktop) (บันทึกจ่าย)  (สะสมแต้ม     review.html   buddy
                                              ลูกค้า/LIFF)  (รีวิวสลิป    (POS iPhone,
                                                            LIFF)        repo แยก)
```

---

## 2. Repositories

| Repo | คืออะไร | Deploy |
|---|---|---|
| **wasuwatn/SMA08** (repo นี้) | Hub API + แอปฝั่งร้านทั้งหมด + หน้าลูกค้า | Hub: Render · หน้า customer: Vercel |
| **wasuwatn/coffee-pos-buddy** | POS ตัวใหม่สำหรับ iPhone (TanStack Start + React), ติดตั้งเป็น PWA ได้ | Vercel |

---

## 3. แอปทั้งหมดในระบบ

โค้ดฝั่ง client ของ SMA08 อยู่ใน tree เดียว (`client/src`) แต่ build แยกเป็นหลายหน้า:

| Entry | แอป | ผู้ใช้ | หน้าที่ |
|---|---|---|---|
| `client/index.html` | **Mother App** | เจ้าของร้าน/แอดมิน | Dashboard, Transaction Log, สต๊อก, BOM/สูตร, ลูกค้า, CRM, แต้ม (Points), โปรโมชั่น, Users, Settings |
| `client/pos.html` | **POS (desktop)** | พนักงานหน้าร้าน | ขายหน้าร้าน, กะเงินสด (shift/Z-report), พิมพ์ใบเสร็จ 58mm, ทำงาน offline ได้ |
| `client/expense.html` | **Expense** | พนักงาน | บันทึกรายจ่าย + เติมสต๊อก |
| `client/customer.html` | **Customer Portal (LIFF)** | ลูกค้า | สะสมแต้ม, ดูประวัติ, แลกแก้วฟรี — ล็อกอินผ่าน LINE (LIFF), build แยกด้วย `npm run build:customer` ขึ้น Vercel |
| `client/expense-review.html` | **Slip Review (LIFF)** | เจ้าของร้าน | รีวิว/แก้สลิปที่ OCR มาจาก LINE ก่อนบันทึกเป็นรายจ่ายจริง, build แยกด้วย `npm run build:expense-review` |
| coffee-pos-buddy | **Kafe POS (iPhone)** | พนักงาน | POS มือถือ — ขาย, PromptPay QR, ใบเสร็จ, ประวัติ — คุยกับ hub ผ่าน REST เหมือน pos.html |

หลักการสำคัญ: **แก้ที่ hub ครั้งเดียว ทุกแอปได้ผลพร้อมกัน** เพราะทุกแอปใช้ API ชุดเดียวกัน

---

## 4. Hub (Server)

- **Stack**: Node.js + Express (`server/index.js`), Postgres ผ่าน `pg` (`server/db.js`)
- **Auth พนักงาน**: JWT อายุ 12 ชม. — สิทธิ์ต่อหน้า/ต่อตารางคุมด้วย `users.access`
  (comma-separated flags) + `TABLE_ACCESS` map ฝั่ง server (บังคับจริงที่ API ไม่ใช่แค่ซ่อน UI)
- **Auth ลูกค้า**: JWT แยกชนิด (`kind: customer`) ออกโดย LINE LIFF id token —
  เข้าได้เฉพาะ endpoint `/api/customer/*` เท่านั้น
- **Generic CRUD**: `/api/:table` (GET/POST/PUT/DELETE) สำหรับตารางที่ประกาศใน `TABLE_CONFIG`
  — `insertRow` กรองคอลัมน์ที่ไม่รู้จักทิ้งเสมอ
- **Checkout ธุรกรรมเดียวจบ** (`runCheckout`): ตัดสต๊อกแบบ atomic (กัน race),
  เผาคูปองแลกฟรี, หักแต้ม (advisory lock ต่อลูกค้า), ออกเลขออเดอร์, บันทึกการขาย,
  ออกโค้ดสะสมแต้มท้ายใบเสร็จ — ทั้งหมดใน transaction เดียว
- **Idempotency**: ทุก checkout ส่ง `client_txn_id` — ยิงซ้ำ (เช่น sync offline ซ้ำ) จะไม่บันทึกซ้ำ

### ตารางหลักใน Postgres

| กลุ่ม | ตาราง |
|---|---|
| ผู้ใช้/ตั้งค่า | `users`, `settings`, `systemlog` |
| เมนู/สูตร | `menuname`, `bom`, `childmenu`, `addons`, `packagingbom`, `matprepbom` |
| สต๊อก | `materials`, `stocklog` |
| การขาย | `salefront` (หน้าร้าน), `saledelivery`, `deliverydaily`, `deliverymenu`, `shifts` |
| การเงิน | `expenses`, `pending_slips` (สลิปรอรีวิวจาก LINE) |
| ลูกค้า/แต้ม | `customers`, `promotions`, `point_ledger`, `redemptions` |
| ระบบ | `processed_txns` (กัน checkout ซ้ำ) |

---

## 5. ระบบสะสมแต้ม (Loyalty)

แต้มทั้งหมดอยู่ในตาราง `point_ledger` แยกชนิดด้วยคอลัมน์ `kind`:

| kind | ที่มา | สถานะเริ่ม |
|---|---|---|
| `link` | ร้านสร้างลิงก์แจกแต้มเอง (หน้า Points ใน Mother) ส่งให้ลูกค้าทาง LINE | `pending` → `claimed` เมื่อลูกค้าคนแรกเปิดลิงก์ |
| `crm` | ร้าน grant ตรงให้ลูกค้าที่รู้จัก (หน้า CRM) | `claimed` ทันที |
| `receipt` | **ใหม่** — ออกอัตโนมัติทุกออเดอร์ POS: QR + รหัส 6 ตัว (ตัวเลข+อักษร) ท้ายใบเสร็จ, แต้ม = จำนวนแก้ว (ไม่นับแก้วฟรี) | `pending` → `claimed` เมื่อลูกค้าแสกน/กรอกรหัส |
| `spend` | หักแต้มตอนแลกแก้วฟรีที่ POS (ค่าติดลบ) | `claimed` |

**Flow แต้มจากใบเสร็จ (ฟีเจอร์ล่าสุด):**
1. ลูกค้าซื้อของที่ POS (ตัวไหนก็ได้ — pos.html หรือ coffee-pos-buddy)
2. hub ออกโค้ด 6 ตัว (ตัดอักษรสับสน 0/O/1/I ออก) ผูกกับเลขออเดอร์ ใส่มากับ response
3. ใบเสร็จพิมพ์ QR + รหัสท้ายใบ (QR ชี้ไป `liff.line.me/<LIFF_ID>?claim=<code>`)
4. ลูกค้าแสกน QR หรือกรอกรหัสในหน้า customer → แต้มเข้าบัญชี (โค้ดใช้ได้ครั้งเดียว)
5. เงื่อนไข: ต้องมีโปรโมชั่น type=`points` ที่ Active อยู่ ถึงจะออกโค้ด

**การแลกแต้ม:** สะสมครบ `promotions.buy_qty` แต้ม → ลูกค้ากดแลกในหน้า customer
ได้คูปอง 6 หลัก (อายุ 1 ชม., ตาราง `redemptions`) → พนักงานกรอกโค้ดที่ POS →
แก้วฟรี (จำกัดราคาไม่เกิน `max_free_value`) → แต้มถูกหักตอน checkout จริงเท่านั้น

---

## 6. ระบบบันทึกรายจ่ายอัตโนมัติผ่าน LINE (Make.com)

1. ถ่ายรูปสลิปส่งเข้า LINE OA ของร้าน
2. **Make.com** รับ webhook → OCR → `POST /api/line/slips` (auth ด้วย shared secret
   `LINE_SLIP_SECRET`) → เก็บเป็น `pending_slips` + ได้ `confirm_token` กลับไป
3. Make ตอบกลับใน LINE พร้อมลิงก์หน้า **expense-review** (LIFF)
4. เจ้าของร้านเปิดลิงก์ แก้ยอด/หมวด/คนซื้อ + เลือกเติมสต๊อกได้ → กดยืนยัน
5. hub เปลี่ยนสลิปเป็นรายจ่ายจริง (`expenses`) + เติมสต๊อกใน transaction เดียว
   — ยืนยันซ้ำไม่ได้ (atomic claim), Make ยิงซ้ำได้ token เดิม (idempotent)

---

## 7. Offline-first (pos.html / expense.html)

- Catalog (เมนู/BOM/วัตถุดิบ) cache ลง localStorage — เน็ตหลุดยังขายต่อได้
- การขาย/รายจ่ายตอน offline เข้า **outbox** ใน localStorage แล้ว sync อัตโนมัติเมื่อกลับ online
  (`force` flag ยอมให้สต๊อก/แต้มติดลบได้ เพราะของถูกส่งมอบไปแล้ว — บันทึกไว้ดีกว่าปฏิเสธ)
- ตอนเปิดแอปครั้งแรกมีหน้า **"กำลังเชื่อมต่อเซิร์ฟเวอร์..."** (BootLoading) กันหน้าเปล่าๆ
  ระหว่างรอ Render ตื่น

---

## 8. Deploy & Environment

| ส่วน | โฮสต์ | หมายเหตุ |
|---|---|---|
| Hub API (+ Mother/pos/expense ที่ hub เสิร์ฟเอง) | **Render** (free tier) | หลับหลังไม่มีคนใช้ ~15 นาที ตื่นช้า ~1 นาที (cold start) |
| Database | **Supabase** Postgres | ต่อผ่าน `DATABASE_URL` |
| หน้า customer (LIFF) | **Vercel** | build แยก: `npm run build:customer` → `dist-customer/` |
| coffee-pos-buddy | **Vercel** | nitro preset ปักเป็น `vercel` แล้ว, ติดตั้งเป็น PWA บน iPhone ได้ |
| Windows exe (ทางเลือก) | `build:exe` ต่างๆ | pkg เป็น .exe รันในร้านแบบ local ได้ |

### Env vars สำคัญ

| ตัวแปร | ที่ | ใช้ทำอะไร |
|---|---|---|
| `DATABASE_URL`, `JWT_SECRET` | hub | DB + เซ็น token (จำเป็น) |
| `CORS_ORIGIN` | hub | จำกัด origin (comma-separated) |
| `LINE_SLIP_SECRET` | hub | secret ของ webhook สลิปจาก Make |
| `VITE_API_BASE` | client builds ทุกตัว | URL ของ hub |
| `VITE_LIFF_ID` | client builds | LIFF app id — ใช้สร้างลิงก์ claim/เปิดหน้า customer ผ่าน LINE |
| `VITE_PORTAL_BASE` | client builds | fallback URL หน้า customer ตอนไม่มี LIFF ID (dev) |

---

## 9. ปัญหาที่รู้อยู่แล้ว / งานค้าง

- **Render cold start**: free tier หลับแล้วตื่นช้า ~1 นาที — มีหน้า loading รองรับแล้ว
  แต่ตัว delay เองยังอยู่ ทางแก้: อัปเกรด Render หรือทำ keep-alive cron (ยังไม่ได้ทำ)
- **หน้า customer ยังไม่มี auto-retry**: ถ้าเปิดตอน hub กำลังตื่น fetch แรกจะ fail
  ต้องกด "ลองใหม่อีกครั้ง" เอง
- **Multi-tenant ยังไม่มี**: ระบบเป็น single-tenant (ร้านเดียว) — ไม่มี shop_id ในตาราง
  ถ้าจะทำ SaaS หลายร้านต้องออกแบบ data isolation ใหม่
