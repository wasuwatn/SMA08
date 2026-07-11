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
  updateRow, deleteRow, hashPassword, verifyPassword, logActivity, claimTxn, adjustStock
} from './db.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set (check server/.env or the host\'s env vars).');
  process.exit(1);
}
const TOKEN_TTL = '12h';

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
app.use(express.json({ limit: '25mb' }));

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
      'SELECT date, menu_name, total_price, is_free FROM salefront WHERE customer_id = $1 ORDER BY id DESC LIMIT 10',
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
app.post('/api/customer/claim-points', requireCustomer, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token is required.' });
  try {
    const customer = await getRow('customers', req.customer.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const { rows, rowCount } = await pool.query(
      `UPDATE point_ledger SET status = 'claimed', customer_id = $2, claimed_at = $3
       WHERE token = $1 AND kind IN ('link', 'receipt') AND status = 'pending' RETURNING points`,
      [token, customer.id, new Date().toISOString()]
    );
    if (rowCount) {
      await logActivity('customer', 'POINTS CLAIM', `${customer.name} (#${customer.id}) +${rows[0].points}`);
      return res.json({ points: rows[0].points, balance: await pointsBalanceFor(customer.id) });
    }
    const { rows: [existing] } = await pool.query(
      "SELECT customer_id, points FROM point_ledger WHERE token = $1 AND kind IN ('link', 'receipt') LIMIT 1", [token]
    );
    if (!existing) return res.status(404).json({ error: 'Code not found.' });
    if (existing.customer_id === customer.id) {
      return res.json({ alreadyClaimed: true, points: existing.points, balance: await pointsBalanceFor(customer.id) });
    }
    res.status(409).json({ error: 'This code has already been claimed.' });
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
  packagingbom: 'bom', matprepbom: 'bom', addons: 'bom',
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
// the free cup and taps this instead of ringing it through the cart). Same
// pending/expiry guard as the lookup above; the conditional UPDATE closes
// the same race two cashiers tapping the same code at once would otherwise hit.
app.post('/api/redemption/:code/use', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM redemptions WHERE code = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1", [req.params.code]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Code not found or already used.' });
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
      await updateRow('redemptions', r.id, { status: 'expired' });
      return res.status(404).json({ error: 'Code expired.' });
    }
    const { rowCount } = await pool.query(
      "UPDATE redemptions SET status = 'used', used_at = $2 WHERE id = $1 AND status = 'pending'",
      [r.id, new Date().toISOString()]
    );
    if (!rowCount) return res.status(409).json({ error: 'Code was just used by someone else.' });
    res.json({ code: r.code, customer_name: r.customer_name });
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
         FROM salefront WHERE shift_id = $1`, [String(shift.id)]
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
    // Never ship password hashes to the browser, even to admins.
    res.json(table === 'users' ? rows.map(({ password, ...r }) => r) : rows);
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
    if (table === 'users' && data.password) data.password = await hashPassword(data.password);
    if (table === 'materials') data.unit_price = materialUnitPrice(data);
    if (table === 'customers') {
      const codeErr = normalizeCustomerCode(data);
      if (codeErr) return res.status(400).json({ error: codeErr });
    }
    let row = await insertRow(table, data);
    if (table === 'users' && row) { const { password, ...safe } = row; row = safe; }
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
    if (table === 'users' && row) { const { password, ...safe } = row; row = safe; }
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
