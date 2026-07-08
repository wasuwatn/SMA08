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
  `LINE_CHANNEL_ID` if the customer rewards LIFF is in use, and `LINE_SLIP_SECRET`
  if the Make.com expense-slip automation (below) is in use.
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
portal:

1. `npm run build:expense-review` (repo root) builds only `expense-review.html`
   into `client/dist-expense-review/`.
2. Create a **second, separate Vercel project** pointed at this repo (the
   existing `vercel.json` is already claimed by the customer portal project).
   In that project's settings, set Install Command `npm --prefix client
   install`, Build Command `npm --prefix client run build:expense-review`,
   Output Directory `client/dist-expense-review` (`vercel.expense-review.json`
   documents the same values for reference / `vercel --local-config` deploys).
   Set env var `VITE_API_BASE=https://<hub-public-url>` (and
   `VITE_EXPENSE_LIFF_ID=<your LIFF id>` once you've created the LIFF app
   below — the page still works without it, just skips the closing chat
   message / auto-close).
3. Add the Vercel domain to the hub's `CORS_ORIGIN` env var and restart the hub.
4. In LINE Developers Console: reuse the same Messaging API channel as the
   rewards bot (or a new one), point its Webhook URL at the Make.com scenario,
   and add a **new LIFF app** (separate from the customer-rewards LIFF —
   this one is for staff, not customers) with Endpoint URL
   `https://<vercel-domain>/` and scope `chat_message.write`.

The hub's own `/expense-review.html` route is left in place as a harmless
local-dev fallback, same as `/customer.html`.

### Kafe POS (coffee-pos-buddy) — the iPhone-first satellite

A second, independently-deployed POS app ([wasuwatn/coffee-pos-buddy](https://github.com/wasuwatn/coffee-pos-buddy))
built specifically for iPhone, wired directly onto this hub instead of its
own database — see that repo's `INTEGRATION_PLAN.md` reference and README
for its own build/deploy steps (Cloudflare Workers via the TanStack Start
nitro build). It's a satellite exactly like `pos.html`: same
`/api/checkout/pos`, `/api/shift/*`, and generic `/api/:table` contract, same
staff JWT login.

To bring it online against this hub:

1. Deploy it (its README covers `bun run build` → Cloudflare Workers) with
   build-time env var `VITE_API_BASE=https://<hub-public-url>`.
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
