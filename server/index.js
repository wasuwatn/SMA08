// SMA V08 - Express API hub (Supabase Postgres) for the Mother + POS/Expense satellite apps
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  pool, initDb, withTransaction, TABLES, TABLE_CONFIG, listRows, insertRow, getRow,
  updateRow, deleteRow, hashPassword, verifyPassword, verifyPin, logActivity, claimTxn, adjustStock
} from './db.js';
import { registerLineExpenseRoutes } from './lineExpense.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set (check server/.env or the host\'s env vars).');
  process.exit(1);
}
const TOKEN_TTL = '12h';
const PIN_RE = /^\d{4}$/;

try {
  await initDb();
} catch (e) {
  // A bad DATABASE_URL or unreachable DB used to hang here forever with no
  // log output at all ("no open ports detected"). Fail loud instead.
  console.error('FATAL: could not connect to the database.', e.message);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

const app = express();
// Render (and most PaaS hosts) sit one reverse-proxy hop in front of us, so
// req.ip / X-Forwarded-For need this to resolve the real client IP — without
// it, express-rate-limit's login limiter can't safely key by IP.
app.set('trust proxy', 1);

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc).
// CSP is left off deliberately: the client pages pull from several external
// origins helmet's default policy would block — Google Fonts (fonts.googleapis.com
// / fonts.gstatic.com), Font Awesome (cdnjs.cloudflare.com), the LINE LIFF SDK
// (static.line-scdn.net, customer.html), a dynamic import of the Supabase JS
// client (esm.sh, Settings.jsx cloud-sync), and — since that cloud-sync feature
// lets a user paste in *any* Supabase project URL — a whitelist can't cover
// connect-src at all. Revisit if that Supabase sync feature is ever removed.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: allow all origins by default (fine when the client is served by this
// same server). Set CORS_ORIGIN (comma-separated) to restrict in production.
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : true;
app.use(cors({ origin: corsOrigins }));
// The LINE Messaging API webhook signs the exact raw request bytes
// (x-line-signature = HMAC-SHA256 over the body), so stash the raw buffer for
// that one path — parsed-then-restringified JSON wouldn't verify.
app.use(express.json({
  limit: '25mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl.startsWith('/api/line/webhook')) req.rawBody = buf;
  }
}));

// Serve the built client (if present) and fall back to it for client-side routing.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
}

// General ceiling on top of the stricter per-route limiters below (login,
// etc). Generous enough for a shop's own registers bursting behind one NAT'd
// IP, tight enough to blunt a scripted flood against the whole API surface.
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api', apiLimiter);

// Keep-alive / cold-start guard. Public (no auth), mounted above every guard.
// The customer portal (customer.html) pings this while it's open, and an
// external cron (cron-job.org, every ~10-14 min) hits it around the clock so
// the free-tier host (Render) never spins down and Supabase never pauses from
// inactivity. The lightweight `SELECT 1` is what creates the DB activity that
// keeps the database out of deep sleep — a bare 200 wouldn't touch Postgres.
app.get('/api/ping', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    // Express itself is awake (that's half the point of the ping); only the DB
    // is unreachable. Report it without leaking driver internals.
    console.error('ping: database unreachable', e.message);
    res.status(503).json({ ok: false });
  }
});

const valid = (t) => Object.prototype.hasOwnProperty.call(TABLE_CONFIG, t);

// 500s log the real error server-side but never echo it to the client —
// raw pg/driver messages leak schema and connection details.
const fail = (res, e) => {
  console.error(e);
  res.status(500).json({ error: 'Internal server error.' });
};

// ---- Auth ----------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
    const user = rows[0];
    const { ok, needsRehash } = await verifyPassword(password, user && user.password);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (needsRehash) {
      await updateRow('users', user.username, { password: await hashPassword(password) });
    }
    await logActivity(user.username, 'User Login', `Logged in user: ${user.username}`);
    const { password: _pw, ...safe } = user;
    const token = jwt.sign(
      { username: safe.username, role: safe.role, access: safe.access },
      JWT_SECRET, { expiresIn: TOKEN_TTL }
    );
    // Seeded accounts ship with password == username (admin/admin). Flag them
    // so the client forces a password change before the app is usable.
    const mustChangePassword = String(password) === String(user.username);
    res.json({ token, user: safe, mustChangePassword });
  } catch (e) {
    fail(res, e);
  }
});

// Staff picker for the POS satellite app's PIN login screen — usernames
// only, no roles/access/hashes. Public and unguarded like /api/auth/login;
// the disclosure is limited to "these people work here", which staff on a
// shared shop device already know about each other.
app.get('/api/auth/staff-list', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT username FROM users ORDER BY username');
    res.json(rows.map(r => r.username));
  } catch (e) {
    fail(res, e);
  }
});

// Per-username PIN lockout, separate from the per-IP loginLimiter below. A
// POS is a single kiosk shared by every staff member all day, so limiting
// only by IP would let one person's mistyped PIN lock the whole shop out —
// this scopes the penalty to the one account instead. In-memory: fine for
// this hub's single-process deployment; would need a shared store (e.g.
// Redis) if it's ever run multi-instance behind a load balancer.
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;
const pinAttempts = new Map(); // username (lowercased) -> { count, lockedUntil }

function isPinLockedOut(username) {
  const entry = pinAttempts.get(String(username).toLowerCase());
  return !!(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
}
function recordFailedPinAttempt(username) {
  const key = String(username).toLowerCase();
  const entry = pinAttempts.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= PIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
    entry.count = 0;
  }
  pinAttempts.set(key, entry);
}
function clearFailedPinAttempts(username) {
  pinAttempts.delete(String(username).toLowerCase());
}

// Loose per-IP limiter — a second, weaker layer behind the per-username
// lockout above (which is what actually matters for a 4-digit keyspace).
// Kept generous because this IP is the one shared kiosk for the whole shop.
const pinLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this device. Please try again later.' }
});

app.post('/api/auth/pin-login', pinLoginLimiter, async (req, res) => {
  const { username = '', pin = '' } = req.body || {};
  if (!username.trim() || !PIN_RE.test(pin)) {
    return res.status(401).json({ error: 'Invalid PIN.' });
  }
  if (isPinLockedOut(username)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
    const user = rows[0];
    const ok = user && await verifyPin(pin, user.pin);
    if (!ok) {
      recordFailedPinAttempt(username);
      return res.status(401).json({ error: 'Invalid PIN.' });
    }
    clearFailedPinAttempts(username);
    await logActivity(user.username, 'User Login', `Logged in via PIN: ${user.username}`);
    const { password: _pw, pin: _pin, ...safe } = user;
    const token = jwt.sign(
      { username: safe.username, role: safe.role, access: safe.access },
      JWT_SECRET, { expiresIn: TOKEN_TTL }
    );
    res.json({ token, user: safe });
  } catch (e) {
    fail(res, e);
  }
});

// ---- Customer (LINE LIFF) portal -----------------------------------------
// These routes are mounted BEFORE the staff guard below and carry their own
// auth. Customer tokens are signed with the same secret but tagged `kind`, and
// the staff guard explicitly rejects them so a customer can't reach /api/:table.
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const CUSTOMER_TTL = '30d';

const signCustomer = (payload, expiresIn = CUSTOMER_TTL) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn });

// Verify a LIFF id_token with LINE and return { lineUserId, name }. Skipped in
// non-production when a devLineUserId is supplied, so the flow is testable
// without the LINE app (which can't open localhost).
async function verifyLineIdToken(idToken, devLineUserId, devName) {
  if (process.env.NODE_ENV !== 'production' && devLineUserId) {
    return { lineUserId: String(devLineUserId), name: devName || 'Dev User' };
  }
  if (!LINE_CHANNEL_ID) throw new Error('LINE_CHANNEL_ID is not set');
  const body = new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID });
  const r = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const data = await r.json();
  if (!r.ok || !data.sub) throw new Error(data.error_description || 'LINE token verification failed');
  return { lineUserId: data.sub, name: data.name || 'Customer' };
}

// Customer-token guard. Verifies signature AND that the token is a customer
// session (not a staff token, not a pre-registration token).
function requireCustomer(req, res, next) {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (claims.kind !== 'customer') return res.status(401).json({ error: 'Customer session required.' });
    req.customer = claims;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// Active points promotion: buy_qty = points per free cup, max_free_value =
// price ceiling for the free cup. The only loyalty type since the rework from
// automatic stamps to shop-issued point links.
async function activePointsPromotion() {
  const { rows } = await pool.query(
    "SELECT * FROM promotions WHERE type = 'points' AND status = 'Active' ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

// Point balance = every claimed ledger row (grants positive, spends negative).
// Pending link rows have no customer_id and never count.
async function pointsBalanceFor(customerId, client = pool) {
  if (customerId == null) return 0;
  const { rows: [r] } = await client.query(
    "SELECT COALESCE(SUM(points), 0) AS balance FROM point_ledger WHERE customer_id = $1 AND status = 'claimed'",
    [customerId]
  );
  return Number(r.balance);
}

// Self-redeem availability: how many free cups this customer can mint a code
// for right now. Mirrors the pre-points stamp math (loyaltyFor): `pending`
// (still-live codes not yet burned) is subtracted so a customer can't mint
// more codes than their balance actually covers, but doesn't touch the
// balance itself — that only happens when a code is burned at POS.
async function redemptionAvailability(customerId, promotion, client = pool) {
  const pointsPerFree = promotion ? Number(promotion.buy_qty) || 0 : 0;
  const maxFreeValue = promotion ? promotion.max_free_value : null;
  const balance = await pointsBalanceFor(customerId, client);
  if (customerId == null || !pointsPerFree) return { balance, pointsPerFree, maxFreeValue, available: 0, pending: 0 };
  const { rows: [p] } = await client.query(
    "SELECT COUNT(*) AS pending FROM redemptions WHERE customer_id = $1 AND status = 'pending' AND expires_at > $2",
    [customerId, new Date().toISOString()]
  );
  const pending = Number(p.pending);
  const available = Math.max(0, Math.floor(balance / pointsPerFree) - pending);
  return { balance, pointsPerFree, maxFreeValue, available, pending };
}

app.post('/api/customer/line-login', async (req, res) => {
  const { idToken, devLineUserId, devName } = req.body || {};
  try {
    const { lineUserId, name } = await verifyLineIdToken(idToken, devLineUserId, devName);
    const { rows } = await pool.query('SELECT * FROM customers WHERE line_user_id = $1', [lineUserId]);
    const customer = rows[0];
    if (customer) {
      const token = signCustomer({ kind: 'customer', customer_id: customer.id, line_user_id: lineUserId });
      return res.json({ token, customer });
    }
    const token = signCustomer({ kind: 'customer_pending', line_user_id: lineUserId, name }, '1h');
    res.json({ needsRegistration: true, token, name });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// Menu names for the "favorite menu" picklist shown at registration. Public
// (no auth) — the registering customer only has a short-lived pre-auth token
// at this point, and a drink menu isn't sensitive.
app.get('/api/customer/menu-options', async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT name FROM menuname WHERE status = 'Active' ORDER BY name");
    res.json(rows.map(r => r.name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const GENDER_VALUES = ['M', 'F', 'NA'];

app.post('/api/customer/register', async (req, res) => {
  const header = req.header('Authorization') || '';
  const tok = header.startsWith('Bearer ') ? header.slice(7) : null;
  let pending;
  try {
    pending = jwt.verify(tok, JWT_SECRET);
    if (pending.kind !== 'customer_pending') throw new Error('bad kind');
  } catch {
    return res.status(401).json({ error: 'Registration session required.' });
  }
  const { phone, gender, date_of_birth, favorite_menu } = req.body || {};
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Phone number is required.' });
  try {
    const lineUserId = pending.line_user_id;
    const profile = {
      gender: GENDER_VALUES.includes(gender) ? gender : 'NA',
      date_of_birth: date_of_birth ? String(date_of_birth).trim() : null,
      favorite_menu: Array.isArray(favorite_menu) ? favorite_menu : []
    };
    // Match an existing customer by phone (link them), else create a new one.
    // Name always comes from the LINE profile — the customer never types it.
    const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1 ORDER BY id LIMIT 1', [String(phone).trim()]);
    let customer = rows[0];
    if (customer) {
      customer = await updateRow('customers', customer.id, { line_user_id: lineUserId, ...profile });
    } else {
      customer = await insertRow('customers', {
        name: (pending.name || 'Customer').trim(), phone: String(phone).trim(), line_user_id: lineUserId, ...profile
      });
    }
    const token = signCustomer({ kind: 'customer', customer_id: customer.id, line_user_id: lineUserId });
    await logActivity('customer', 'LINE REGISTER', `${customer.name} (#${customer.id})`);
    res.json({ token, customer });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/customer/me', requireCustomer, async (req, res) => {
  try {
    const customer = await getRow('customers', req.customer.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const promotion = await activePointsPromotion();
    const { balance: pointsBalance, pointsPerFree, maxFreeValue, available: pointsAvailable, pending: pointsPending }
      = await redemptionAvailability(customer.id, promotion);
    const { rows: recentOrders } = await pool.query(
      "SELECT date, menu_name, total_price, is_free FROM salefront WHERE customer_id = $1 AND status IS DISTINCT FROM 'void' ORDER BY id DESC LIMIT 10",
      [customer.id]
    );
    const { rows: pointsHistory } = await pool.query(
      'SELECT points, kind, note, created_at, claimed_at, order_no FROM point_ledger WHERE customer_id = $1 ORDER BY id DESC LIMIT 20',
      [customer.id]
    );
    const { rows: coupons } = await pool.query(
      'SELECT code, status, created_at, expires_at, used_at, used_order_no FROM redemptions WHERE customer_id = $1 ORDER BY id DESC LIMIT 20',
      [customer.id]
    );
    // Shop name comes from the same settings row the receipt header uses.
    const { rows: [shop] } = await pool.query('SELECT * FROM settings LIMIT 1');
    res.json({
      customer, pointsBalance, pointsPerFree, maxFreeValue, pointsAvailable, pointsPending,
      pointsHistory, coupons, recentOrders, shopName: (shop && shop.shop_name) || 'KOTEA'
    });
  } catch (e) {
    fail(res, e);
  }
});

// Mint a self-redeem code once the customer's balance covers a free cup.
// Single-use, 1-hour expiry — the customer shows the code/QR at the counter,
// staff looks it up (GET /api/redemption/:code) and burns it at checkout.
// Availability subtracts still-pending codes so a customer can't mint more
// than their balance covers; the balance itself is only debited when the
// code is actually burned.
app.post('/api/customer/redeem', requireCustomer, async (req, res) => {
  try {
    const customer = await getRow('customers', req.customer.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const promotion = await activePointsPromotion();
    if (!promotion) return res.status(400).json({ error: 'No active promotion.' });
    const info = await redemptionAvailability(customer.id, promotion);
    if (info.available < 1) return res.status(409).json({ error: 'Not enough points for a free cup yet.' });
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000); // +1 hr
    // A partial unique index guards against two live codes colliding; on that
    // (rare, 1-in-~900000) chance retry with a freshly rolled code instead of
    // failing the customer's request outright.
    let row;
    for (let attempt = 0; !row && attempt < 5; attempt++) {
      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
      try {
        row = await insertRow('redemptions', {
          code, customer_id: customer.id, customer_name: customer.name, promotion_id: promotion.id,
          status: 'pending', created_at: now.toISOString(), expires_at: expires.toISOString()
        });
      } catch (e) {
        if (e.code !== '23505') throw e; // not a code collision — a real failure
      }
    }
    if (!row) return res.status(500).json({ error: 'Could not generate a redemption code, please try again.' });
    res.json({ code: row.code, expires_at: row.expires_at, max_free_value: promotion.max_free_value });
  } catch (e) {
    fail(res, e);
  }
});

// Claim a shop-issued point link OR a POS receipt claim code (same token
// column, distinguished only by `kind`: 'link' for staff-issued shareable
// links, 'receipt' for the per-order QR/6-char code printed on receipts).
// Single-use, no expiry: the atomic UPDATE guard (same pattern as the old
// redemption burn) means only the first customer wins; a retry by the SAME
// customer is answered idempotently so LIFF page reloads / double-taps
// (or the customer.html manual-entry form) don't surface errors.
// A 'receipt' code also carries the POS order_no it was printed on, so on a
// successful claim we attribute that order's still-unlinked (walk-in) sale
// rows to the claiming customer — the purchase then shows up in their order
// history alongside the points. Ledger update + sale-row linking run in one
// transaction so points and history land together.
app.post('/api/customer/claim-points', requireCustomer, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token is required.' });
  const customerId = req.customer.customer_id;
  try {
    const customer = await getRow('customers', customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const result = await withTransaction(async (client) => {
      const { rows, rowCount } = await client.query(
        `UPDATE point_ledger SET status = 'claimed', customer_id = $2, claimed_at = $3
         WHERE token = $1 AND kind IN ('link', 'receipt') AND status = 'pending'
         RETURNING points, kind, order_no`,
        [token, customerId, new Date().toISOString()]
      );
      if (rowCount) {
        const { points, kind, order_no } = rows[0];
        // Guard `customer_id IS NULL` so we never re-attribute an order a
        // cashier already linked to someone else — and it makes re-claims /
        // concurrent double-taps idempotent (they link 0 rows). A 'link'
        // code has no order_no and skips this entirely.
        if (kind === 'receipt' && order_no) {
          await client.query(
            'UPDATE salefront SET customer_id = $1 WHERE order_no = $2 AND customer_id IS NULL',
            [customerId, order_no]
          );
        }
        return { claimed: true, points };
      }
      const { rows: [existing] } = await client.query(
        "SELECT customer_id, points FROM point_ledger WHERE token = $1 AND kind IN ('link', 'receipt') LIMIT 1", [token]
      );
      if (!existing) return { error: 'NOT_FOUND' };
      if (existing.customer_id === customerId) return { alreadyClaimed: true, points: existing.points };
      return { error: 'CLAIMED_BY_OTHER' };
    });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Code not found.' });
    if (result.error === 'CLAIMED_BY_OTHER') return res.status(409).json({ error: 'This code has already been claimed.' });
    if (result.claimed) {
      await logActivity('customer', 'POINTS CLAIM', `${customer.name} (#${customerId}) +${result.points}`);
    }
    res.json({ ...(result.alreadyClaimed ? { alreadyClaimed: true } : {}), points: result.points, balance: await pointsBalanceFor(customerId) });
  } catch (e) {
    fail(res, e);
  }
});

// ---- LINE receipt-OCR expense intake (Make.com automation) ----------------
// Make.com posts a slip here right after OCR; a human then reviews/edits it
// from a LIFF page before it becomes a real `expenses` row. Mounted before
// the staff guard below because neither caller carries a staff JWT — Make
// authenticates with a shared secret, the LIFF page with the slip's own
// one-time `confirm_token` (no separate login for that page).
// See INTEGRATION_PLAN.md Phase 1 for the full flow.
const LINE_SLIP_SECRET = process.env.LINE_SLIP_SECRET;

app.post('/api/line/slips', async (req, res) => {
  if (!LINE_SLIP_SECRET || req.header('X-Line-Webhook-Secret') !== LINE_SLIP_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret.' });
  }
  const { line_message_id, line_user_id, amount, merchant, slip_image_url, ocr_raw } = req.body || {};
  if (!line_message_id) return res.status(400).json({ error: 'line_message_id is required.' });
  try {
    const insertPending = async () => insertRow('pending_slips', {
      line_message_id, line_user_id: line_user_id || null,
      amount: Number(amount) || 0, merchant: String(merchant || '').trim(),
      slip_image_url: slip_image_url || null,
      ocr_raw: ocr_raw ? JSON.stringify(ocr_raw) : null,
      status: 'pending', confirm_token: crypto.randomBytes(24).toString('hex'),
      created_at: new Date().toISOString()
    });
    let row;
    try {
      row = await insertPending();
    } catch (e) {
      // Make retries the same webhook delivery on timeout/5xx — a second call
      // for the same LINE message must return the SAME confirm_token, not
      // fail or mint a second pending row for one physical slip.
      if (e.code !== '23505') throw e;
      const { rows } = await pool.query('SELECT * FROM pending_slips WHERE line_message_id = $1', [line_message_id]);
      row = rows[0];
    }
    res.json({ id: row.id, confirm_token: row.confirm_token });
  } catch (e) {
    fail(res, e);
  }
});

// Loads a pending slip for the LIFF review page. The token IS the auth for
// this one slip — wrong token or an already-confirmed slip both 404 so a
// guessed id leaks nothing.
app.get('/api/line/slips/:id', async (req, res) => {
  const token = String(req.query.token || '');
  try {
    const slip = await getRow('pending_slips', req.params.id);
    if (!slip || !token || slip.confirm_token !== token || slip.status !== 'pending') {
      return res.status(404).json({ error: 'Slip not found or already processed.' });
    }
    const { rows: catRows } = await pool.query(
      "SELECT DISTINCT category FROM expenses WHERE category IS NOT NULL AND category <> '' ORDER BY category"
    );
    const { rows: [settings] } = await pool.query('SELECT buyers FROM settings LIMIT 1');
    const buyers = String(settings?.buyers || '').split(',').map(s => s.trim()).filter(Boolean);
    const { rows: materials } = await pool.query(
      "SELECT id, item, name, unit FROM materials WHERE status = 'Active' ORDER BY item"
    );
    res.json({
      slip: {
        id: slip.id, merchant: slip.merchant, amount: slip.amount, category: slip.category,
        slip_image_url: slip.slip_image_url, created_at: slip.created_at
      },
      categories: catRows.map(r => r.category),
      buyers, materials
    });
  } catch (e) {
    fail(res, e);
  }
});

// Confirms a pending slip: turns it into a real expense (+ optional stock
// replenishment) in one transaction. Atomic claim-with-guard on the UPDATE
// itself (same pattern as runCheckout's redemption burn above) — a re-tapped
// button or a re-opened LIFF tab can't double-book the same slip.
app.post('/api/line/slips/:id/confirm', async (req, res) => {
  const token = String(req.body?.token || '');
  const merchant = String(req.body?.merchant || '').trim();
  const amount = Number(req.body?.amount);
  const category = String(req.body?.category || '').trim();
  const buyer = String(req.body?.buyer || '').trim();
  const note = String(req.body?.note || '').trim();
  const restock = req.body?.restock;
  if (!merchant) return res.status(400).json({ error: 'Merchant / description is required.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });
  try {
    const expenseRow = await withTransaction(async (client) => {
      const claim = await client.query(
        `UPDATE pending_slips SET status = 'completed', confirmed_at = $3
         WHERE id = $1 AND confirm_token = $2 AND status = 'pending' RETURNING id`,
        [req.params.id, token, new Date().toISOString()]
      );
      if (!claim.rowCount) return null; // bad token / already confirmed — no-op
      const slipId = claim.rows[0].id;
      const row = await insertRow('expenses', {
        date: new Date().toISOString().split('T')[0],
        description: merchant, amount,
        buyer: buyer || 'LINE', category: category || 'Other',
        note: `LINE slip #${slipId}${note ? ' — ' + note : ''}`
      }, client);
      if (restock && restock.material_id) {
        const increment = Number(restock.increment) || 0;
        if (increment > 0) {
          const adj = await adjustStock(restock.material_id, increment, { client });
          if (adj.ok) {
            await insertRow('stocklog', {
              date: row.date, material_id: restock.material_id, action: 'Replenishment',
              qty_changed: increment, note: `LINE slip #${slipId} replenishment`
            }, client);
          }
        }
      }
      await client.query('UPDATE pending_slips SET expense_id = $2 WHERE id = $1', [slipId, row.id]);
      return row;
    });
    if (!expenseRow) return res.status(409).json({ error: 'This slip was already confirmed or the link is invalid.' });
    await logActivity('line-slip', 'EXPENSE', merchant);
    res.json({ ok: true, expense_id: expenseRow.id });
  } catch (e) {
    fail(res, e);
  }
});

// In-chat LINE expense bot (send a receipt photo / text to the OA, pick items
// to record, all inside LINE chat). Mounted before the staff guard below —
// LINE's webhook carries no JWT; it authenticates with x-line-signature.
// See server/lineExpense.js.
registerLineExpenseRoutes(app);

// All routes below require a valid STAFF token. Customer tokens are rejected
// here so they can't reach the generic CRUD / checkout routes.
app.use('/api', (req, res, next) => {
  const header = req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (String(claims.kind || '').startsWith('customer')) {
      return res.status(401).json({ error: 'Staff session required.' });
    }
    req.user = claims;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session.' });
  }
});

const actor = (req) => req.user?.username || 'system';
const isAdmin = (req) => req.user?.role === 'Admin';

// ---- Table-level write authorization --------------------------------------
// Mirrors the access flags in users.access that the client uses to hide pages;
// before this map existed the flags were cosmetic — any staff token could write
// any table (including users, i.e. self-promote to Admin). Reads stay open to
// all staff (dashboards need them), except the users table.
const TABLE_ACCESS = {
  users: 'ADMIN', systemlog: 'ADMIN', processed_txns: 'ADMIN',
  settings: 'settings', promotions: 'promotions',
  materials: 'materials', menuname: 'bom', bom: 'bom', childmenu: 'bom',
  packagingbom: 'bom', matprepbom: 'bom', addons: 'bom', categories: 'bom',
  customers: 'customers', redemptions: 'pos', salefront: 'pos', shifts: 'pos',
  point_ledger: 'points',
  saledelivery: 'delivery', deliverydaily: 'delivery', deliverymenu: 'delivery',
  stocklog: 'stock', expenses: 'expenses'
};

function canWrite(req, table) {
  if (isAdmin(req)) return true;
  const need = TABLE_ACCESS[table];
  if (!need || need === 'ADMIN') return false;
  return String(req.user?.access || '').split(',').map(s => s.trim()).includes(need);
}

const forbidden = (res) => res.status(403).json({ error: 'You do not have permission for this action.' });

// Self-service password change (any authenticated staff account). Used by the
// forced-change flow when someone logs in with a default password.
app.post('/api/auth/change-password', async (req, res) => {
  const { currentPassword = '', newPassword = '' } = req.body || {};
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  if (String(newPassword) === String(req.user.username)) {
    return res.status(400).json({ error: 'Password cannot be the same as the username.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.user.username]);
    const user = rows[0];
    const { ok } = await verifyPassword(currentPassword, user && user.password);
    if (!user || !ok) return res.status(401).json({ error: 'Current password is incorrect.' });
    await updateRow('users', user.username, { password: await hashPassword(newPassword) });
    await logActivity(user.username, 'PASSWORD CHANGE', 'User changed own password');
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// Self-service PIN change/set — requires the account's own password (there's
// no "current PIN" to check against on a first-time set, since pin starts
// NULL). Same authenticated shape as change-password above.
app.post('/api/auth/set-pin', async (req, res) => {
  const { currentPassword = '', newPin = '' } = req.body || {};
  if (!PIN_RE.test(newPin)) {
    return res.status(400).json({ error: 'PIN must be 4 digits.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.user.username]);
    const user = rows[0];
    const { ok } = await verifyPassword(currentPassword, user && user.password);
    if (!user || !ok) return res.status(401).json({ error: 'Current password is incorrect.' });
    await updateRow('users', user.username, { pin: await hashPassword(newPin) });
    await logActivity(user.username, 'PIN CHANGE', 'User changed own PIN');
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/tables', (_req, res) => res.json(TABLES));

// ---- Shop-issued point links & grants -------------------------------------
// Links are minted here (Points page / CRM), claimed by the customer in the
// LINE portal via POST /api/customer/claim-points above. The client builds the
// share URL from the token — the server doesn't need to know the portal origin.

app.post('/api/points/link', async (req, res) => {
  if (!canWrite(req, 'point_ledger')) return forbidden(res);
  const points = Number(req.body?.points);
  if (!Number.isInteger(points) || points <= 0) {
    return res.status(400).json({ error: 'Points must be a positive whole number.' });
  }
  try {
    const row = await insertRow('point_ledger', {
      token: crypto.randomBytes(16).toString('hex'),
      points, kind: 'link', status: 'pending',
      note: String(req.body?.note || '').trim() || null,
      created_by: actor(req), created_at: new Date().toISOString()
    });
    await logActivity(actor(req), 'POINTS LINK', `+${points} points link #${row.id}`);
    res.json({ id: row.id, token: row.token, points: row.points });
  } catch (e) {
    fail(res, e);
  }
});

app.get('/api/points/links', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const { rows } = await pool.query(
      `SELECT pl.id, pl.points, pl.status, pl.note, pl.token,
              pl.created_by, pl.created_at, pl.claimed_at, c.name AS claimed_by
       FROM point_ledger pl LEFT JOIN customers c ON c.id = pl.customer_id
       WHERE pl.kind = 'link' ORDER BY pl.id DESC LIMIT $1`, [limit]
    );
    res.json(rows);
  } catch (e) {
    fail(res, e);
  }
});

// Void an unclaimed link (mis-created amount, wrong recipient). Claimed links
// are immutable history and can't be voided.
app.delete('/api/points/link/:id', async (req, res) => {
  if (!canWrite(req, 'point_ledger')) return forbidden(res);
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM point_ledger WHERE id = $1 AND kind = 'link' AND status = 'pending'", [req.params.id]
    );
    if (!rowCount) return res.status(409).json({ error: 'Link already claimed or not found.' });
    await logActivity(actor(req), 'POINTS LINK VOID', `Link #${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// Direct grant to a known customer (CRM page) — no link, lands claimed.
app.post('/api/points/grant', async (req, res) => {
  if (!canWrite(req, 'point_ledger')) return forbidden(res);
  const points = Number(req.body?.points);
  const customerId = Number(req.body?.customer_id);
  if (!Number.isInteger(points) || points <= 0) {
    return res.status(400).json({ error: 'Points must be a positive whole number.' });
  }
  try {
    const customer = await getRow('customers', customerId);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const now = new Date().toISOString();
    await insertRow('point_ledger', {
      customer_id: customer.id, points, kind: 'crm', status: 'claimed',
      note: String(req.body?.note || '').trim() || null,
      created_by: actor(req), created_at: now, claimed_at: now
    });
    await logActivity(actor(req), 'POINTS GRANT', `${customer.name} (#${customer.id}) +${points}`);
    res.json({ ok: true, balance: await pointsBalanceFor(customer.id) });
  } catch (e) {
    fail(res, e);
  }
});

// Point balance + redeem availability for the POS register (replaces the old
// /api/loyalty stamps lookup). Only registered customers can hold points, so
// this keys strictly on customer_id.
app.get('/api/points/balance', async (req, res) => {
  try {
    const promotion = await activePointsPromotion();
    const customerId = Number(req.query.customer_id);
    const info = await redemptionAvailability(Number.isInteger(customerId) ? customerId : null, promotion);
    res.json(info);
  } catch (e) {
    fail(res, e);
  }
});

// Read the receipt claim code + points for one order, so a satellite POS can
// render/reprint the loyalty QR from history (the checkout response's one-time
// claim code isn't persisted client-side). Returns the pending 'receipt'
// point_ledger row this order minted at checkout. Ungated like the other
// /api/points GETs — the code is meant to be printed on the receipt anyway.
// `status` lets the client tell a still-claimable code ('pending') from one the
// customer already claimed; a voided bill has no receipt row (see void below),
// so it comes back null.
app.get('/api/points/receipt/:order_no', async (req, res) => {
  try {
    const { rows: [row] } = await pool.query(
      "SELECT token, points, status FROM point_ledger WHERE order_no = $1 AND kind = 'receipt' LIMIT 1",
      [String(req.params.order_no)]
    );
    if (!row) return res.json({ claim_code: null, points: 0, status: null });
    res.json({ claim_code: row.token, points: row.points, status: row.status });
  } catch (e) {
    fail(res, e);
  }
});

// Soft-void a whole bill (Admin only). The cups stay in salefront flagged
// status='void' — visible in history, recoverable — but every aggregation
// filters them out (shift close, dashboards, customer history). We refuse to
// void a bill whose loyalty points a customer has already claimed or spent,
// since reversing a customer's balance is out of scope here. The pending
// receipt claim code is deleted so the voided bill can no longer earn points.
// Note: a bill in an already-closed shift won't retroactively change that
// shift's frozen Z-report snapshot — live totals and later shifts are correct.
app.post('/api/salefront/void/:order_no', async (req, res) => {
  if (!isAdmin(req)) return forbidden(res);
  const orderNo = String(req.params.order_no);
  try {
    const result = await withTransaction(async (client) => {
      const { rows: ledger } = await client.query(
        "SELECT kind, status FROM point_ledger WHERE order_no = $1 AND kind IN ('receipt', 'spend')",
        [orderNo]
      );
      if (ledger.some(l => l.kind === 'receipt' && l.status === 'claimed')) return { error: 'POINTS_CLAIMED' };
      if (ledger.some(l => l.kind === 'spend')) return { error: 'POINTS_SPENT' };
      const { rowCount } = await client.query(
        "UPDATE salefront SET status = 'void' WHERE order_no = $1 AND status IS DISTINCT FROM 'void'",
        [orderNo]
      );
      if (!rowCount) return { error: 'NOT_FOUND' };
      await client.query(
        "DELETE FROM point_ledger WHERE order_no = $1 AND kind = 'receipt' AND status = 'pending'",
        [orderNo]
      );
      return { voided: rowCount };
    });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'ไม่พบบิลนี้ (หรือยกเลิกไปแล้ว)' });
    if (result.error === 'POINTS_CLAIMED') return res.status(409).json({ error: 'บิลนี้ลูกค้ารับแต้มไปแล้ว ยกเลิกไม่ได้' });
    if (result.error === 'POINTS_SPENT') return res.status(409).json({ error: 'บิลนี้ใช้แต้มแลกของฟรี ยกเลิกไม่ได้' });
    await logActivity(actor(req), 'SALE VOID', `Order #${orderNo} (${result.voided} cup${result.voided > 1 ? 's' : ''})`);
    res.json({ voided: true, order_no: orderNo, rows: result.voided });
  } catch (e) {
    fail(res, e);
  }
});

// Staff-side lookup of a self-redeem code entered at POS. Returns the pending
// redemption + customer name + the promo's price ceiling, or 404 if it's
// unknown, already used, or expired.
app.get('/api/redemption/:code', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM redemptions WHERE code = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1", [req.params.code]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Code not found or already used.' });
    // expires_at is TIMESTAMPTZ (comes back as a Date object) — compare as
    // timestamps, not strings, or `Date < isoString` silently never expires.
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
      await updateRow('redemptions', r.id, { status: 'expired' });
      return res.status(404).json({ error: 'Code expired.' });
    }
    const promo = await getRow('promotions', r.promotion_id);
    res.json({ id: r.id, code: r.code, customer_name: r.customer_name, customer_id: r.customer_id,
      promotion_id: r.promotion_id, max_free_value: promo ? promo.max_free_value : null });
  } catch (e) {
    fail(res, e);
  }
});

// Mark a self-redeem code as used directly, without attaching it to a
// checkout/order (the mobile POS "coupons" screen — staff just hands over
// the free cup and taps this instead of ringing it through the cart). Still
// has to charge the same points a checkout-burned redemption would, or the
// customer's balance never drops and they can mint free cups forever — the
// advisory lock + balance check below mirror runCheckout's pointFreeCups
// block exactly, just without an order_no attached to the ledger row.
app.post('/api/redemption/:code/use', async (req, res) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM redemptions WHERE code = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
        [req.params.code]
      );
      const r = rows[0];
      if (!r) return { error: 'NOT_FOUND' };
      if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
        await updateRow('redemptions', r.id, { status: 'expired' }, client);
        return { error: 'EXPIRED' };
      }
      if (r.customer_id == null) return { error: 'NO_CUSTOMER' };
      const promotion = await activePointsPromotion();
      const pointsPerFree = promotion ? Number(promotion.buy_qty) || 0 : 0;
      if (pointsPerFree > 0) {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [POINTS_LOCK_KEY, r.customer_id]);
        const balance = await pointsBalanceFor(r.customer_id, client);
        if (balance < pointsPerFree) return { error: 'INSUFFICIENT_POINTS' };
        await insertRow('point_ledger', {
          customer_id: r.customer_id, points: -pointsPerFree, kind: 'spend', status: 'claimed',
          note: 'Free cup redemption (coupon marked used at POS)',
          created_by: actor(req), created_at: new Date().toISOString(), claimed_at: new Date().toISOString(),
          order_no: null
        }, client);
      }
      const { rowCount } = await client.query(
        "UPDATE redemptions SET status = 'used', used_at = $2 WHERE id = $1 AND status = 'pending'",
        [r.id, new Date().toISOString()]
      );
      if (!rowCount) return { error: 'RACE_LOST' };
      return { code: r.code, customer_name: r.customer_name };
    });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Code not found or already used.' });
    if (result.error === 'EXPIRED') return res.status(404).json({ error: 'Code expired.' });
    if (result.error === 'NO_CUSTOMER') return res.status(400).json({ error: 'Code has no linked customer.' });
    if (result.error === 'INSUFFICIENT_POINTS') return res.status(409).json({ error: 'Customer no longer has enough points for this coupon.' });
    if (result.error === 'RACE_LOST') return res.status(409).json({ error: 'Code was just used by someone else.' });
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

// ---- Checkout (transactional stock deduction) ----------------------------
// body: { sales:[{...}], requirements:[{material_id, qty, note}], date }
// One row per cup is inserted; stock requirements are aggregated for the order.
// `force` (set only when flushing an offline-queued sale) skips the stock guard
// and allows stock to go negative: the sale already happened on the device, so
// we record it rather than reject it. Online sales leave force unset.
// Advisory-lock namespace for per-customer point spends (two-arg form:
// key1 = this constant, key2 = customer_id), same idea as SHIFT_LOCK_KEY below.
const POINTS_LOCK_KEY = 823402;

// Alphabet excludes 0/O/1/I so a customer typing the code from a receipt at
// customer.html can't confuse look-alike characters.
const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateClaimCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CLAIM_CODE_ALPHABET[crypto.randomInt(CLAIM_CODE_ALPHABET.length)];
  return code;
}

async function runCheckout(table, body, user) {
  const sales = body.sales || (body.sale ? [body.sale] : []);
  const { requirements = [], date, client_txn_id, force = false, expense = null, redemption_id = null } = body;
  const rows = await withTransaction(async (client) => {
    if (!(await claimTxn(client_txn_id, client))) return null; // already synced
    // A self-redeem code may only be consumed once and must still be pending.
    // Atomic claim-with-guard (same pattern as adjustStock below): the guard
    // rides on the UPDATE itself so two concurrent checkouts scanning the same
    // code can't both pass a stale read and both burn it. Burning it here is
    // just bookkeeping (which order used the code) — the actual point charge
    // below is driven by the free cups themselves, so a cashier can equally
    // mark a cup free by typing the customer's name with no code at all.
    if (redemption_id) {
      const claim = await client.query(
        "UPDATE redemptions SET status = 'used', used_at = $2 WHERE id = $1 AND status = 'pending' RETURNING id",
        [redemption_id, new Date().toISOString()]
      );
      if (!claim.rowCount) throw new Error('REDEMPTION_INVALID');
    }
    for (const r of requirements) {
      // Atomic deduct-with-guard: the guard rides on the UPDATE itself so two
      // concurrent checkouts can't both pass a stale read and lose an update.
      const adj = await adjustStock(r.material_id, -r.qty, { client, guard: !force });
      if (adj.missing) continue; // unknown material — nothing to deduct
      if (!adj.ok) {
        const err = new Error('INSUFFICIENT_STOCK');
        err.material = adj.item;
        throw err;
      }
      await insertRow('stocklog', {
        date: date || new Date().toISOString().split('T')[0],
        material_id: r.material_id, action: 'Sale Deduction',
        qty_changed: -r.qty, note: r.note || (force ? 'Offline sync' : '')
      }, client);
    }
    // One order number per checkout (not per cup), so the front register's
    // Sales History can group rows by order instead of guessing from name/date.
    // Resolve customer_id once per checkout (walk-ins stay null).
    let resolvedCustomerId = null;
    if (table === 'salefront' && sales.length) {
      const custName = (sales[0].customer_name || '').trim();
      if (custName && custName.toLowerCase() !== 'walk-in') {
        const { rows: cr } = await client.query(
          'SELECT id FROM customers WHERE lower(name) = lower($1) LIMIT 1', [custName]);
        if (cr[0]) resolvedCustomerId = cr[0].id;
      }
    }
    let orderNo = null;
    if (table === 'salefront' && sales.length) {
      const { rows: [{ next }] } = await client.query("SELECT nextval('salefront_order_seq') AS next");
      orderNo = String(next).padStart(4, '0');
    }
    // Point-funded free cups: is_free='1' + non-empty promotion_id. (is_free='1'
    // with an empty promotion_id is a staff goodwill comp — no points involved.)
    // This fires whether the cashier got here via a customer-minted redeem code
    // (burned above, for the record) or just typed the customer's name and
    // ticked "Use free redemption" directly — both set promotion_id client-side,
    // so the code is optional, not required. Charge the balance inside this
    // transaction, serialized per customer by an advisory lock — a plain
    // SUM-then-INSERT could let two registers both pass the balance check under
    // READ COMMITTED. `force` (offline flush) skips the balance guard like the
    // stock guard above: the cups were already handed over, so record the spend
    // even if it goes negative — the ledger keeps it visible.
    const pointFreeCups = table === 'salefront'
      ? sales.filter(s => s.is_free === '1' && String(s.promotion_id || '').trim()).length
      : 0;
    if (pointFreeCups > 0) {
      if (resolvedCustomerId == null) throw new Error('POINTS_NO_CUSTOMER');
      const promotion = await activePointsPromotion();
      const pointsPerFree = promotion ? Number(promotion.buy_qty) || 0 : 0;
      if (pointsPerFree > 0) {
        const cost = pointsPerFree * pointFreeCups;
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [POINTS_LOCK_KEY, resolvedCustomerId]);
        if (!force) {
          const balance = await pointsBalanceFor(resolvedCustomerId, client);
          if (balance < cost) {
            const err = new Error('INSUFFICIENT_POINTS');
            err.balance = balance;
            throw err;
          }
        }
        await insertRow('point_ledger', {
          customer_id: resolvedCustomerId, points: -cost, kind: 'spend', status: 'claimed',
          note: `Free cup redemption (${pointFreeCups} cup${pointFreeCups > 1 ? 's' : ''})`,
          created_by: user, created_at: new Date().toISOString(),
          claimed_at: new Date().toISOString(), order_no: orderNo
        }, client);
      }
    }
    // Additive loyalty mechanism (on top of the shop-issued point links/CRM
    // grants above, unchanged): every completed POS order earns a receipt
    // claim code worth one point per cup actually sold — free/points-redeemed
    // cups don't re-earn. Requires an active points promotion (nothing to
    // redeem points for otherwise). Customer scans the QR or types the code
    // into customer.html to claim it (POST /api/customer/claim-points).
    let claimCode = null;
    let claimPoints = 0;
    if (table === 'salefront' && sales.length) {
      claimPoints = sales.filter(s => s.is_free !== '1').length;
      if (claimPoints > 0 && await activePointsPromotion()) {
        for (let attempt = 0; !claimCode && attempt < 5; attempt++) {
          const candidate = generateClaimCode();
          try {
            await insertRow('point_ledger', {
              token: candidate, points: claimPoints, kind: 'receipt', status: 'pending',
              note: `Receipt claim (${claimPoints} cup${claimPoints > 1 ? 's' : ''})`,
              created_by: user, created_at: new Date().toISOString(), order_no: orderNo
            }, client);
            claimCode = candidate;
          } catch (e) {
            if (e.code !== '23505') throw e; // code collision — retry with a fresh one
          }
        }
      }
    }
    const out = [];
    for (const s of sales) {
      const row = orderNo ? { ...s, order_no: orderNo } : { ...s };
      if (table === 'salefront' && resolvedCustomerId != null) row.customer_id = resolvedCustomerId;
      out.push(await insertRow(table, row, client));
    }
    // insertRow filters unknown columns, so the claim code can't ride on the
    // salefront row itself — attach it to the returned object after the fact
    // so it reaches the checkout response without a schema change.
    if (claimCode && out[0]) {
      out[0].claim_code = claimCode;
      out[0].claim_points = claimPoints;
    }
    // Promo giveaway cups are recorded as a cost (their BOM materials are
    // still deducted above like any other cup) rather than silently eating
    // into margin with no trace.
    if (expense && expense.amount > 0) await insertRow('expenses', expense, client);
    // Code was already claimed atomically above; just record which order burned it.
    if (redemption_id) {
      await updateRow('redemptions', redemption_id, { used_order_no: orderNo }, client);
    }
    return out;
  });
  if (rows === null) return { duplicate: true };
  await logActivity(user, 'CHECKOUT', `${table}: ${sales.length} cup(s)`);
  return rows;
}

app.post('/api/checkout/pos', async (req, res) => {
  if (!canWrite(req, 'salefront')) return forbidden(res);
  try { res.json(await runCheckout('salefront', req.body, actor(req))); }
  catch (e) {
    if (e.message === 'INSUFFICIENT_STOCK') return res.status(409).json({ error: 'Insufficient stock', material: e.material });
    if (e.message === 'REDEMPTION_INVALID') return res.status(409).json({ error: 'Redemption code already used or expired.' });
    if (e.message === 'INSUFFICIENT_POINTS') return res.status(409).json({ error: 'Customer does not have enough points.', balance: e.balance });
    if (e.message === 'POINTS_NO_CUSTOMER') return res.status(409).json({ error: 'Free (points) cups require a registered customer.' });
    fail(res, e);
  }
});

app.post('/api/checkout/delivery', async (req, res) => {
  if (!canWrite(req, 'saledelivery')) return forbidden(res);
  try { res.json(await runCheckout('saledelivery', req.body, actor(req))); }
  catch (e) {
    if (e.message === 'INSUFFICIENT_STOCK') return res.status(409).json({ error: 'Insufficient stock', material: e.material });
    fail(res, e);
  }
});

// ---- Delivery report import (Wongnai) ------------------------------------
// Daily-aggregate import that replaces the per-cup checkout for delivery.
// body: {
//   daily:[{date, sales, orders, avgBasketSize}],   // sales = after discount, before GP
//   menu:[{menuName, amount, sales}],               // full menu price for the period
//   newMenus:[{name, delivery_price}],              // drink names missing from menuname
//   requirements:[{material_id, qty, note}],        // computed client-side from BOM
//   period:{start, end}, source
// }
// Idempotent per day/period: re-importing replaces rows. Stock is deducted only
// on the FIRST import of a period (so re-imports never double-deduct).
const DELIVERY_GP_RATE = 0.321;

app.post('/api/import/delivery', async (req, res) => {
  if (!canWrite(req, 'deliverydaily')) return forbidden(res);
  const {
    daily = [], menu = [], newMenus = [], requirements = [],
    period = {}, source = 'Wongnai'
  } = req.body || {};
  try {
    const result = await withTransaction(async (client) => {
      // 1) Daily summary — upsert by date.
      for (const d of daily) {
        if (!d.date) continue;
        const gross = Number(d.sales) || 0;
        await client.query('DELETE FROM deliverydaily WHERE date = $1', [d.date]);
        await insertRow('deliverydaily', {
          date: d.date, gross_sales: gross, orders: Number(d.orders) || 0,
          avg_basket: Number(d.avgBasketSize) || 0,
          gp_amount: gross * DELIVERY_GP_RATE, net_sales: gross * (1 - DELIVERY_GP_RATE),
          source, note: ''
        }, client);
      }

      // 2) Menu breakdown — replace rows for this period. If the period already
      //    had rows, this is a re-import: keep sales fresh but skip stock.
      let firstImport = true;
      if (period.start && period.end) {
        const { rows } = await client.query(
          'SELECT COUNT(*)::int c FROM deliverymenu WHERE period_start = $1 AND period_end = $2',
          [period.start, period.end]
        );
        firstImport = rows[0].c === 0;
        await client.query('DELETE FROM deliverymenu WHERE period_start = $1 AND period_end = $2',
          [period.start, period.end]);
      }
      for (const m of menu) {
        await insertRow('deliverymenu', {
          period_start: period.start, period_end: period.end, menu_name: m.menuName,
          qty: Number(m.amount) || 0, sales: Number(m.sales) || 0, source
        }, client);
      }

      // 3) Auto-create drink names missing from menuname (no BOM yet).
      const { rows: existing } = await client.query('SELECT id, name FROM menuname');
      const have = new Set(existing.map(r => String(r.name).toLowerCase()));
      let maxNum = existing.reduce((mx, r) => {
        const m = /^MN(\d+)$/.exec(String(r.id)); return m ? Math.max(mx, Number(m[1])) : mx;
      }, 0);
      const created = [];
      for (const nm of newMenus) {
        const name = String(nm.name || '').trim();
        if (!name || have.has(name.toLowerCase())) continue;
        const id = 'MN' + String(++maxNum).padStart(3, '0');
        await insertRow('menuname', {
          id, name, category: 'Delivery', front_price: 0,
          delivery_price: Number(nm.delivery_price) || 0, status: 'Active'
        }, client);
        have.add(name.toLowerCase());
        created.push(name);
      }

      // 4) Deduct materials (only first import of a period; only menus with BOM).
      let deducted = 0;
      if (firstImport) {
        for (const r of requirements) {
          const adj = await adjustStock(r.material_id, -r.qty, { client });
          if (!adj.ok) continue;
          await insertRow('stocklog', {
            date: period.end || new Date().toISOString().split('T')[0],
            material_id: r.material_id, action: 'Delivery Import',
            qty_changed: -r.qty, note: r.note || `Delivery import ${period.start || ''}–${period.end || ''}`
          }, client);
          deducted++;
        }
      }
      return { days: daily.length, menuRows: menu.length, created, firstImport, deducted };
    });
    await logActivity(actor(req), 'IMPORT',
      `delivery ${period.start || ''}–${period.end || ''}: ${result.days} day(s), ${result.menuRows} menu row(s)`);
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

// ---- Expense + optional restock (transactional) --------------------------
// body: { expense:{...}, restock:{material_id, increment}|null, client_txn_id? }
app.post('/api/expense', async (req, res) => {
  if (!canWrite(req, 'expenses')) return forbidden(res);
  const { expense, restock, client_txn_id } = req.body;
  try {
    const row = await withTransaction(async (client) => {
      if (!(await claimTxn(client_txn_id, client))) return { duplicate: true }; // already synced
      const row = await insertRow('expenses', expense, client);
      if (restock && restock.material_id) {
        const adj = await adjustStock(restock.material_id, restock.increment, { client });
        if (adj.ok) {
          await insertRow('stocklog', {
            date: expense.date, material_id: restock.material_id, action: 'Replenishment',
            qty_changed: restock.increment, note: `Expense #${row.id} replenishment`
          }, client);
        }
      }
      return row;
    });
    await logActivity(actor(req), 'EXPENSE', expense.description || '');
    res.json(row);
  } catch (e) {
    fail(res, e);
  }
});

// ---- Register shifts (open / close with Z-report) -------------------------
// One shift may be open at a time. POS stamps each sale row with the open
// shift's id, so closing aggregates exactly the rows rung during the shift.
const SHIFT_LOCK_KEY = 823401; // arbitrary advisory-lock key for open/close races

app.get('/api/shift/current', async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1");
    res.json(rows[0] || null);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/shift/open', async (req, res) => {
  if (!canWrite(req, 'shifts')) return forbidden(res);
  const openingCash = Number(req.body?.opening_cash) || 0;
  try {
    const row = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SHIFT_LOCK_KEY]);
      const { rows } = await client.query("SELECT id FROM shifts WHERE status = 'open' LIMIT 1");
      if (rows.length) throw new Error('SHIFT_ALREADY_OPEN');
      return insertRow('shifts', {
        status: 'open', opened_at: new Date().toISOString(),
        opened_by: actor(req), opening_cash: openingCash
      }, client);
    });
    await logActivity(actor(req), 'SHIFT OPEN', `Shift #${row.id}, opening float ${openingCash}`);
    res.json(row);
  } catch (e) {
    if (e.message === 'SHIFT_ALREADY_OPEN') return res.status(409).json({ error: 'A shift is already open.' });
    fail(res, e);
  }
});

app.post('/api/shift/close', async (req, res) => {
  if (!canWrite(req, 'shifts')) return forbidden(res);
  const { closing_cash = null, note = '' } = req.body || {};
  try {
    const summary = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SHIFT_LOCK_KEY]);
      const { rows } = await client.query("SELECT * FROM shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1");
      const shift = rows[0];
      if (!shift) throw new Error('NO_OPEN_SHIFT');
      // Sales with no payment_method (offline rows queued before the cashier
      // picked one, or legacy clients) are counted as cash — the safe default
      // for reconciling the drawer.
      const { rows: [agg] } = await client.query(
        `SELECT
           COALESCE(SUM(total_price) FILTER (WHERE COALESCE(NULLIF(payment_method, ''), 'Cash') = 'Cash'), 0) AS cash_sales,
           COALESCE(SUM(total_price) FILTER (WHERE payment_method = 'PromptPay'), 0) AS promptpay_sales,
           COALESCE(SUM(total_price) FILTER (WHERE payment_method = 'Transfer'), 0) AS transfer_sales,
           COALESCE(SUM(total_price), 0) AS total_sales,
           COUNT(DISTINCT order_no) AS orders,
           COUNT(*) AS cups,
           COUNT(*) FILTER (WHERE is_free = '1') AS free_cups
         FROM salefront WHERE shift_id = $1 AND status IS DISTINCT FROM 'void'`, [String(shift.id)]
      );
      const cashSales = Number(agg.cash_sales);
      const expected = Number(shift.opening_cash || 0) + cashSales;
      const closingCash = (closing_cash === null || closing_cash === '') ? null : Number(closing_cash);
      const updated = await updateRow('shifts', shift.id, {
        status: 'closed', closed_at: new Date().toISOString(), closed_by: actor(req),
        closing_cash: closingCash, expected_cash: expected, cash_sales: cashSales,
        promptpay_sales: Number(agg.promptpay_sales), transfer_sales: Number(agg.transfer_sales),
        orders: Number(agg.orders), over_short: closingCash === null ? null : closingCash - expected,
        note: String(note || '')
      }, client);
      return {
        shift: updated,
        totals: {
          total_sales: Number(agg.total_sales), cups: Number(agg.cups), free_cups: Number(agg.free_cups)
        }
      };
    });
    await logActivity(actor(req), 'SHIFT CLOSE', `Shift #${summary.shift.id}`);
    res.json(summary);
  } catch (e) {
    if (e.message === 'NO_OPEN_SHIFT') return res.status(409).json({ error: 'No open shift.' });
    fail(res, e);
  }
});

// ---- Backup / restore (Admin only) ---------------------------------------
app.get('/api/backup', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
  try {
    const out = {};
    for (const t of TABLES) out[t] = await listRows(t);
    res.json(out);
  } catch (e) {
    fail(res, e);
  }
});

app.post('/api/restore', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
  const payload = req.body || {};
  try {
    await withTransaction(async (client) => {
      for (const t of TABLES) {
        if (Array.isArray(payload[t])) {
          await client.query(`DELETE FROM ${t}`);
          for (const row of payload[t]) await insertRow(t, row, client);
        }
      }
    });
    await logActivity(actor(req), 'RESTORE', 'JSON backup restored');
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// ---- Generic CRUD (registered last so specific routes take priority) -----
// GET supports optional windowing on tables that have a `date` column
// (?since=YYYY-MM-DD&until=YYYY-MM-DD) plus ?limit=N (newest first) so clients
// don't have to pull a whole table once history grows.
app.get('/api/:table', async (req, res) => {
  const { table } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  if (table === 'users' && !isAdmin(req)) return forbidden(res);
  try {
    const cfg = TABLE_CONFIG[table];
    const where = [];
    const params = [];
    if (cfg.columns.includes('date')) {
      const { since, until } = req.query;
      if (since) { params.push(String(since)); where.push(`date >= $${params.length}`); }
      if (until) { params.push(String(until)); where.push(`date <= $${params.length}`); }
    }
    let sql = `SELECT * FROM ${table}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) sql += ` ORDER BY ${cfg.pk} DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, params);
    // Never ship password/PIN hashes to the browser, even to admins.
    res.json(table === 'users' ? rows.map(({ password, pin, ...r }) => r) : rows);
  } catch (e) {
    fail(res, e);
  }
});

// The settings.logo column holds a base64 data URL fetched on every login —
// mirrors the client-side cap in Settings.jsx but enforced here too, since a
// client isn't trusted to police its own uploads.
const MAX_LOGO_LEN = 400 * 1024; // ~300KB of binary data as base64 text
const logoTooBig = (table, data) => table === 'settings' && typeof data.logo === 'string' && data.logo.length > MAX_LOGO_LEN;

// Per-base-unit cost of a material = pack price / (pack qty * usable yield).
// Computed server-side so it can never drift from price/qty/yield, regardless
// of what the client sends.
function materialUnitPrice({ price, qty, yield: yld }) {
  const p = Number(price) || 0, q = Number(qty) || 0, y = Number(yld) || 0;
  return q > 0 && y > 0 ? p / (q * (y / 100)) : 0;
}

// Staff-assigned customer code: 1 English letter + 3 digits (e.g. A001).
// Uppercased in place; returns an error message, or null if OK/absent.
const CUSTOMER_CODE_RE = /^[A-Za-z]\d{3}$/;
function normalizeCustomerCode(data) {
  if (data.code === undefined) return null;
  const raw = String(data.code || '').trim().toUpperCase();
  if (!raw) { data.code = null; return null; }
  if (!CUSTOMER_CODE_RE.test(raw)) {
    return 'รหัสลูกค้าต้องเป็นตัวอักษรภาษาอังกฤษ 1 ตัว ตามด้วยตัวเลข 3 หลัก เช่น A001';
  }
  data.code = raw;
  return null;
}

app.post('/api/:table', async (req, res) => {
  const { table } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  if (!canWrite(req, table)) return forbidden(res);
  if (logoTooBig(table, req.body || {})) return res.status(413).json({ error: 'Logo image is too large.' });
  try {
    const data = { ...req.body };
    if (table === 'users') {
      if (data.password) data.password = await hashPassword(data.password);
      if (data.pin) {
        if (!PIN_RE.test(data.pin)) return res.status(400).json({ error: 'PIN must be 4 digits.' });
        data.pin = await hashPassword(data.pin);
      }
    }
    if (table === 'materials') data.unit_price = materialUnitPrice(data);
    if (table === 'customers') {
      const codeErr = normalizeCustomerCode(data);
      if (codeErr) return res.status(400).json({ error: codeErr });
    }
    let row = await insertRow(table, data);
    if (table === 'users' && row) { const { password, pin, ...safe } = row; row = safe; }
    if (table !== 'systemlog') await logActivity(actor(req), 'DB INSERT', `${table}: ${JSON.stringify(data).slice(0, 120)}`);
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'รหัสลูกค้านี้ถูกใช้งานแล้ว กรุณาใช้รหัสอื่น' });
    fail(res, e);
  }
});

app.put('/api/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  if (!canWrite(req, table)) return forbidden(res);
  if (logoTooBig(table, req.body || {})) return res.status(413).json({ error: 'Logo image is too large.' });
  try {
    const data = { ...req.body };
    if (table === 'users') {
      if (data.password) data.password = await hashPassword(data.password);
      else delete data.password; // keep existing when blank
      if (data.pin) {
        if (!PIN_RE.test(data.pin)) return res.status(400).json({ error: 'PIN must be 4 digits.' });
        data.pin = await hashPassword(data.pin);
      } else {
        delete data.pin; // keep existing when blank
      }
    }
    // Recompute unit_price whenever any of its inputs change, merging with the
    // current row so a partial update (e.g. status-only toggle) leaves it alone.
    if (table === 'materials' && ['price', 'qty', 'yield'].some(k => data[k] !== undefined)) {
      const current = await getRow('materials', id);
      data.unit_price = materialUnitPrice({ ...current, ...data });
    }
    if (table === 'customers') {
      const codeErr = normalizeCustomerCode(data);
      if (codeErr) return res.status(400).json({ error: codeErr });
    }
    let row = await updateRow(table, id, data);
    if (table === 'users' && row) { const { password, pin, ...safe } = row; row = safe; }
    if (table !== 'systemlog') await logActivity(actor(req), 'DB UPDATE', `${table}#${id}`);
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'รหัสลูกค้านี้ถูกใช้งานแล้ว กรุณาใช้รหัสอื่น' });
    fail(res, e);
  }
});

app.delete('/api/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  if (!canWrite(req, table)) return forbidden(res);
  try {
    await deleteRow(table, id);
    if (table !== 'systemlog') await logActivity(actor(req), 'DB DELETE', `${table}#${id}`);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// Multi-page SPA fallback: each satellite app gets its own HTML shell;
// all other non-API routes fall back to the Mother app (index.html).
if (fs.existsSync(CLIENT_DIST)) {
  const distFile = (name) => path.join(CLIENT_DIST, name);
  app.get('/pos.html', (_req, res) => res.sendFile(distFile('pos.html')));
  app.get('/expense.html', (_req, res) => res.sendFile(distFile('expense.html')));
  app.get('/customer.html', (_req, res) => res.sendFile(distFile('customer.html')));
  app.get('/expense-review.html', (_req, res) => res.sendFile(distFile('expense-review.html')));
  // If LINE LIFF redirects back to root with liff.state param, forward to the portal.
  app.get('/', (req, res) => {
    if ('liff.state' in req.query) {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect(302, `/customer.html?${qs}`);
    }
    res.sendFile(distFile('index.html'));
  });
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(distFile('index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SMA V08 hub API running on http://localhost:${PORT}`));
