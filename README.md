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
A user only reaches an app if their access flags include `pos` / `expenses`.

## Deploying (cloud / multi-device)

- Hub → any Node host (Render/Railway/Fly). Set `DATABASE_URL`, `JWT_SECRET`, and
  `CORS_ORIGIN` (comma-separated origins of the satellite apps).
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

## Notes / deferred (ponytail)

- Offline login isn't supported — a device must sign in online once; after that the
  cached session + catalog let POS run offline. Add a cached-credential path only if
  shifts start on dead internet.
- Offline queue lives in `localStorage` (fine for tens of sales/day). Swap
  `client/src/lib/outbox.js` to IndexedDB only if a queue must hold thousands.
- Single branch. No `location_id` yet — add the column (and `migrate()` backfills it)
  when a second branch actually opens.
