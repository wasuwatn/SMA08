# SMA V08 — KOTEA (hub + satellite apps)

Rebuild of V07 split into a central **hub** and two **satellite** apps that send
data to it. One React/Vite codebase with three entry points + one Express API.

```
Supabase Postgres ── Express hub API (JWT, idempotent writes, CORS)
                          │
        ┌─────────────────┼─────────────────┐
   index.html         pos.html          expense.html
   Mother             POS (PWA,         Expense (PWA)
   (display/admin)    offline-first)
```

- **Mother** (`index.html`) — dashboards, CRM, inventory, recipes, delivery import, users, settings. Read/admin only; no POS or expense entry.
- **POS** (`pos.html`) — front sales. Installable, works offline: catalog is cached and sales are queued in `localStorage`, then synced when the network returns. Server dedups by `client_txn_id`, so retries never double-count.
- **Expense** (`expense.html`) — log expenses + auto-restock. Same offline queue.

All three share `client/src/` (lib, components, pages) — fix a bug once, all apps get it.

## Setup

1. Create the Supabase project, then put its connection string in `server/.env`:
   ```
   DATABASE_URL=postgresql://...   # JWT_SECRET is already generated
   ```
2. Install + run:
   ```bash
   npm run setup
   npm run dev      # hub on :4000, client on :5173
   ```
3. Open:
   - Mother:  http://localhost:5173/
   - POS:     http://localhost:5173/pos.html
   - Expense: http://localhost:5173/expense.html

Default logins (seeded on first run): `admin / admin`, `staff / staff`.
Logging in with a default password forces a password change before the app opens.
A user only reaches an app if their access flags include `pos` / `expenses` —
and the server enforces the same flags on every write (each table maps to an
access flag; the `users` table is Admin-only).

## POS day-to-day

- **Shifts** — open a shift (count the float) before selling; every sale is
  stamped with the shift id. Closing produces a Z-report (sales by payment
  method, expected vs counted cash) and can print it.
- **Payments** — Cash (with received/change), PromptPay (QR generated from the
  PromptPay ID in Settings → Receipt & Payment), or Transfer.
- **Receipts** — 58mm slips via the browser print dialog; reprint from Sales
  History or the "Print last receipt" button.

## Deploying (cloud / multi-device)

- Hub → any Node host (Render/Railway/Fly). Set `DATABASE_URL`, `JWT_SECRET`, and
  `CORS_ORIGIN` (comma-separated origins of the satellite apps). Set
  `LINE_CHANNEL_ID` if the customer rewards LIFF is in use, `LINE_SLIP_SECRET`
  if the Make.com expense-slip automation (below) is in use, and
  `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` + `OPENAI_API_KEY` if the
  in-chat LINE expense bot (below) is in use, and additionally
  `LINE_EXPENSE_LIFF_ID` (same value as the client build's
  `VITE_EXPENSE_LIFF_ID`, see below) to get the bot's "แก้ไขรายการ" button —
  without it the Flex card just omits that button and only offers
  บันทึกทั้งหมด/ยกเลิก.
- Satellite apps → build (`npm run build`) and serve the `dist/` from the hub or a
  static host over **HTTPS** (required for the PWA service worker). Point them at
  the hub with `VITE_API_BASE=https://your-hub` at build time.

### Deploying the customer portal separately (Vercel)

`customer.html` (the LINE LIFF rewards portal) can be deployed on its own,
independent of the Mother/POS/Expense apps — needed because LINE's LIFF
"Endpoint URL" must point at a stable public HTTPS domain, while the hub and
staff apps may only run intermittently.

1. `npm run build:customer` (repo root) builds only `customer.html` and its
   own chunks into `client/dist-customer/` — no admin/POS code included.
2. `vercel.json` at the repo root already points Vercel at that build: set
   the project's env vars to `VITE_API_BASE=https://<hub-public-url>` and
   `VITE_LIFF_ID=<your LIFF id>`, then deploy.
3. Add the Vercel domain to the hub's `CORS_ORIGIN` env var (comma-separated
   with any existing origins) and restart the hub.
4. In LINE Developers Console, set the LIFF app's Endpoint URL to
   `https://<vercel-domain>/`.

The hub's own `/customer.html` route and `liff.state` redirect are left in
place as a harmless fallback for local dev — nothing to remove there.

#### Keeping the backend warm (cold-start guard)

Vercel serves `customer.html` as a static site, but the hub API it talks to
(and Supabase behind it) run on free tiers that go to sleep: Render spins the
hub down after ~15 min with no traffic, and Supabase pauses a project after a
long idle stretch. The first customer to open the portal then waits out a slow
cold start on login.

Two layers guard against this:

1. **While the portal is open** — `customer.html` pings `GET /api/ping` on load
   and every 10 min (see `CustomerPortal.jsx`). `/api/ping` runs a tiny
   `SELECT 1`, so it wakes the hub *and* touches Supabase. No setup needed.
2. **Around the clock** — the in-page ping only fires while someone has the
   portal open, so add an external scheduler for continuous coverage. On
   [cron-job.org](https://cron-job.org) (free) create a job that sends
   `GET https://<hub-public-url>/api/ping` every **10–14 minutes** (shorter than
   Render's ~15 min idle window). `/api/ping` needs no auth and returns
   `{ ok: true }`. This is what actually keeps the hub from ever sleeping.

### LINE expense-slip automation (Make.com) + review portal (Vercel)

Human-in-the-loop expense capture: a receipt photo sent to the shop's LINE OA
is OCR'd by a Make.com scenario, POSTed to the hub as a "pending slip", and a
staff member reviews/edits it in a LIFF page before it becomes a real
`expenses` row (with optional stock replenishment). Full design in
[`INTEGRATION_PLAN.md`](./INTEGRATION_PLAN.md) (Phase 1).

**Hub side** — set `LINE_SLIP_SECRET` (any random string) on the hub. Make.com
sends it back as the `X-Line-Webhook-Secret` header on `POST /api/line/slips`,
the only way in without a staff/customer session:

- `POST /api/line/slips` — Make.com calls this after OCR (`X-Line-Webhook-Secret`
  header required). Upserts by `line_message_id` (idempotent — a retried
  webhook delivery returns the same slip instead of creating a duplicate) and
  returns `{ id, confirm_token }`.
- `GET /api/line/slips/:id?token=...` / `POST /api/line/slips/:id/confirm` —
  used by the review page below; the slip's own `confirm_token` (from the
  Flex Message button URL) is the only auth, no staff login required.

**Review page** (`expense-review.html`) deploys the same way as the customer
portal — as a **second, separate Vercel project** pointed at this repo (the
root `vercel.json` is already claimed by the customer portal project). Two
ways to set that project up:

- **Git-connected, no local Node/CLI needed** — when importing the repo as a
  new Vercel project, set **Root Directory** to `client`. Vercel then reads
  `client/vercel.json` (install/build/output + the SPA rewrite) instead of
  the root one, so it never conflicts with the customer portal project. Every
  push to the branch auto-deploys, built entirely on Vercel's servers.
- **CLI, for one-off/manual deploys** — from the repo root run
  `vercel --local-config vercel.expense-review.json` (documents the same
  install/build/output values as `client/vercel.json`, just resolved from the
  repo root instead of `client/`).

Either way, set env var `VITE_API_BASE=https://<hub-public-url>` (and
`VITE_EXPENSE_LIFF_ID=<your LIFF id>` once you've created the LIFF app
below — the page still works without it, just skips the closing chat
message / auto-close) in the Vercel project's settings, then:

1. Add the Vercel domain to the hub's `CORS_ORIGIN` env var and restart the hub.
2. In LINE Developers Console: reuse the same Messaging API channel as the
   rewards bot (or a new one), point its Webhook URL at the Make.com scenario,
   and add a **new LIFF app** (separate from the customer-rewards LIFF —
   this one is for staff, not customers) with Endpoint URL
   `https://<vercel-domain>/` and scope `chat_message.write`.

The hub's own `/expense-review.html` route is left in place as a harmless
local-dev fallback, same as `/customer.html`.

### In-chat LINE expense bot (no LIFF, no Make.com)

The newer, chat-only expense intake (`server/lineExpense.js`): an allow-listed
staff member sends a receipt photo — or a text like `ค่ากาแฟ 40 ไข่ 60` — to the
shop's LINE OA. The hub receives the webhook directly, has OpenAI GPT-4o-mini
extract categorized line items, and replies with a Flex card listing them.
Tapping **บันทึกทั้งหมด** records every item as one `expenses` row each, in a
single transaction, and replies with a summary — the common case is one tap.
Removing an item first goes through the **แก้ไขรายการ** button instead of a
postback-per-item toggle: LINE can't edit a message it already sent, so every
toggle used to mean waiting for a whole new chat message. That button opens
the expense-review LIFF page (`?flow=chat`, same page/app as the Make.com flow
below) with plain checkboxes — instant, no round trip until the one final
save. Reward customers share the OA; anyone not in the allowlist is ignored
without a reply, so the bot is invisible to them.

For itemized receipts (e.g. a 10-20 line supermarket/wholesale invoice) the
model also reads the receipt's own printed total and cross-checks it against
the sum of the items it extracted; a mismatch beyond rounding sends a warning
message ahead of the item card instead of silently under-reporting. Accuracy
still depends on photo quality — straight-on, well-lit, unfolded shots read
far more reliably than a rotated or blurry one.

Setup:

1. **OpenAI**: create an API key at platform.openai.com → hub env
   `OPENAI_API_KEY`.
2. **LINE Developers Console**: open the OA's **Messaging API** channel (this
   is a different channel type from the LINE-Login/LIFF channel that
   `LINE_CHANNEL_ID` belongs to; create one for the OA if it doesn't exist).
   Copy the **channel secret** → hub env `LINE_CHANNEL_SECRET`; issue a
   long-lived **channel access token** → hub env `LINE_CHANNEL_ACCESS_TOKEN`.
3. Set the channel's **Webhook URL** to
   `https://<hub-public-url>/api/line/webhook`, enable **Use webhook**, press
   **Verify** (expects 200). Enabling **Redelivery** is safe — deliveries are
   idempotent by LINE message id.
4. In LINE Official Account Manager, turn **off** auto-reply/greeting messages
   so canned replies don't interleave with the bot's cards (note this affects
   the whole OA, including reward customers).
5. **แก้ไขรายการ button (optional but recommended)** — if the expense-review
   LIFF page from the section above is already deployed, set hub env
   `LINE_EXPENSE_LIFF_ID` to the same LIFF id as that page's
   `VITE_EXPENSE_LIFF_ID`. It's the same deployed page and same LIFF app —
   nothing new to create. Without this env var the card just skips the
   button, offering only บันทึกทั้งหมด/ยกเลิก.
6. In Mother → Settings → Store Options, fill **LINE expense users** with
   `U<lineUserId>:BuyerName` entries (comma separated). To find a user's ID:
   have them message the OA once and read it from the hub log
   (`ignored message from non-allowlisted user U...`), or have an
   already-listed user type `myid` in the chat.

Cold starts (Render free tier) are covered by the same cron-job.org keep-alive
described above; LINE's webhook redelivery bridges any remaining gap.

The Make.com + LIFF flow above still works independently — both write to the
same `pending_slips` table and `expenses` ledger.

### Kafe POS (coffee-pos-buddy) — the iPhone-first satellite

A second, independently-deployed POS app ([wasuwatn/coffee-pos-buddy](https://github.com/wasuwatn/coffee-pos-buddy))
built specifically for iPhone, wired directly onto this hub instead of its
own database — see that repo's `INTEGRATION_PLAN.md` reference and README
for its own build/deploy steps (Vercel, same as this repo's LIFF pages —
its TanStack Start/nitro build is pinned to the `vercel` preset). It's a
satellite exactly like `pos.html`: same `/api/checkout/pos`, `/api/shift/*`,
and generic `/api/:table` contract, same staff JWT login.

To bring it online against this hub:

1. Deploy it (its README covers `bun run build` → `vercel deploy --prebuilt`,
   or a GitHub-connected Vercel project) with build-time env var
   `VITE_API_BASE=https://<hub-public-url>`.
2. Add its deployed origin to the hub's `CORS_ORIGIN` env var and restart the hub.
3. Run it side by side with `pos.html` for a trial period before retiring
   the older POS — both write through the same endpoints, so sales/stock
   never conflict; just don't open two shifts at once (the hub only allows
   one open shift at a time).

## Notes / deferred (ponytail)

- Offline login isn't supported — a device must sign in online once; after that the
  cached session + catalog let POS run offline. Add a cached-credential path only if
  shifts start on dead internet.
- Offline queue lives in `localStorage` (fine for tens of sales/day). Swap
  `client/src/lib/outbox.js` to IndexedDB only if a queue must hold thousands.
- Single branch. No `location_id` yet — add the column (and `migrate()` backfills it)
  when a second branch actually opens.
- Clients still load whole tables. When `salefront` grows past a few tens of
  thousands of rows, switch reads to the windowed form the API already supports:
  `GET /api/salefront?since=2026-01-01&until=2026-12-31` or `?limit=500`
  (newest first). Loyalty math keys on `customer_id` (name matching only as a
  legacy fallback), so windowed sales history won't break stamp counts server-side.
