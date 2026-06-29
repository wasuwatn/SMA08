// SMA V08 - Express API hub (Supabase Postgres) for the Mother + POS/Expense satellite apps
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pool, initDb, withTransaction, TABLES, TABLE_CONFIG, listRows, insertRow, getRow,
  updateRow, deleteRow, hashPassword, verifyPassword, logActivity, claimTxn
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

const valid = (t) => Object.prototype.hasOwnProperty.call(TABLE_CONFIG, t);

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
    res.json({ token, user: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// Active stamp promotion (the only auto-loyalty type today).
async function activeStampPromotion() {
  const { rows } = await pool.query(
    "SELECT * FROM promotions WHERE type = 'stamp' AND status = 'Active' ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

// Stamp-loyalty status for a customer name. Mirrors loyaltyStatus() on the
// client: purchased = paid cups, given = free cups already rung, pending = open
// redemption codes not yet used. available subtracts pending so codes can't be
// over-minted.
async function loyaltyFor(customerName, promotion) {
  if (!customerName || !promotion) return { purchased: 0, given: 0, available: 0, pending: 0 };
  const { rows: [c] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(is_free,'0') <> '1') AS purchased,
       COUNT(*) FILTER (WHERE is_free = '1') AS given
     FROM salefront WHERE lower(customer_name) = lower($1)`, [customerName]
  );
  const { rows: [p] } = await pool.query(
    "SELECT COUNT(*) AS pending FROM redemptions WHERE lower(customer_name) = lower($1) AND status = 'pending' AND expires_at > $2",
    [customerName, new Date().toISOString()]
  );
  const purchased = Number(c.purchased), given = Number(c.given), pending = Number(p.pending);
  const buyQty = Number(promotion.buy_qty) || 1;
  const available = Math.max(0, Math.floor(purchased / buyQty) - given - pending);
  return { purchased, given, pending, available };
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
  const { phone, name } = req.body || {};
  if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Phone number is required.' });
  try {
    const lineUserId = pending.line_user_id;
    // Match an existing customer by phone (link them), else create a new one.
    const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1 ORDER BY id LIMIT 1', [String(phone).trim()]);
    let customer = rows[0];
    if (customer) {
      customer = await updateRow('customers', customer.id, { line_user_id: lineUserId });
    } else {
      customer = await insertRow('customers', {
        name: (name || pending.name || 'Customer').trim(), phone: String(phone).trim(), line_user_id: lineUserId
      });
    }
    const token = signCustomer({ kind: 'customer', customer_id: customer.id, line_user_id: lineUserId });
    await logActivity('customer', 'LINE REGISTER', `${customer.name} (#${customer.id})`);
    res.json({ token, customer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/customer/me', requireCustomer, async (req, res) => {
  try {
    const customer = await getRow('customers', req.customer.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const promotion = await activeStampPromotion();
    const loyalty = await loyaltyFor(customer.name, promotion);
    const { rows: recentOrders } = await pool.query(
      'SELECT date, menu_name, total_price, is_free FROM salefront WHERE lower(customer_name) = lower($1) ORDER BY id DESC LIMIT 10',
      [customer.name]
    );
    res.json({ customer, promotion, loyalty, recentOrders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/customer/redeem', requireCustomer, async (req, res) => {
  try {
    const customer = await getRow('customers', req.customer.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const promotion = await activeStampPromotion();
    if (!promotion) return res.status(400).json({ error: 'No active promotion.' });
    const loyalty = await loyaltyFor(customer.name, promotion);
    if (loyalty.available < 1) return res.status(409).json({ error: 'No free cups available.' });
    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 60 * 1000); // +30 min
    const row = await insertRow('redemptions', {
      code, customer_id: customer.id, customer_name: customer.name, promotion_id: promotion.id,
      status: 'pending', created_at: now.toISOString(), expires_at: expires.toISOString()
    });
    res.json({ code: row.code, expires_at: row.expires_at, max_free_value: promotion.max_free_value });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

app.get('/api/tables', (_req, res) => res.json(TABLES));

// ---- Checkout (transactional stock deduction) ----------------------------
// body: { sales:[{...}], requirements:[{material_id, qty, note}], date }
// One row per cup is inserted; stock requirements are aggregated for the order.
// `force` (set only when flushing an offline-queued sale) skips the stock guard
// and allows stock to go negative: the sale already happened on the device, so
// we record it rather than reject it. Online sales leave force unset.
async function runCheckout(table, body, user) {
  const sales = body.sales || (body.sale ? [body.sale] : []);
  const { requirements = [], date, client_txn_id, force = false, expense = null, redemption_id = null } = body;
  const rows = await withTransaction(async (client) => {
    if (!(await claimTxn(client_txn_id, client))) return null; // already synced
    // A self-redeem code may only be consumed once and must still be pending.
    if (redemption_id) {
      const r = await getRow('redemptions', redemption_id, client);
      if (!r || r.status !== 'pending') {
        const err = new Error('REDEMPTION_INVALID');
        throw err;
      }
    }
    if (!force) {
      for (const r of requirements) {
        const mat = await getRow('materials', r.material_id, client);
        if (mat && mat.current_stock < r.qty) {
          const err = new Error('INSUFFICIENT_STOCK');
          err.material = mat.item;
          throw err;
        }
      }
    }
    for (const r of requirements) {
      const mat = await getRow('materials', r.material_id, client);
      if (!mat) continue;
      await updateRow('materials', r.material_id, { current_stock: mat.current_stock - r.qty }, client);
      await insertRow('stocklog', {
        date: date || new Date().toISOString().split('T')[0],
        material_id: r.material_id, action: 'Sale Deduction',
        qty_changed: -r.qty, note: r.note || (force ? 'Offline sync' : '')
      }, client);
    }
    // One order number per checkout (not per cup), so the front register's
    // Sales History can group rows by order instead of guessing from name/date.
    let orderNo = null;
    if (table === 'salefront' && sales.length) {
      const { rows: [{ next }] } = await client.query("SELECT nextval('salefront_order_seq') AS next");
      orderNo = String(next).padStart(4, '0');
    }
    const out = [];
    for (const s of sales) out.push(await insertRow(table, orderNo ? { ...s, order_no: orderNo } : s, client));
    // Promo giveaway cups are recorded as a cost (their BOM materials are
    // still deducted above like any other cup) rather than silently eating
    // into margin with no trace.
    if (expense && expense.amount > 0) await insertRow('expenses', expense, client);
    // Burn the self-redeem code in the same txn so it can't be reused.
    if (redemption_id) {
      await updateRow('redemptions', redemption_id, {
        status: 'used', used_at: new Date().toISOString(), used_order_no: orderNo
      }, client);
    }
    return out;
  });
  if (rows === null) return { duplicate: true };
  await logActivity(user, 'CHECKOUT', `${table}: ${sales.length} cup(s)`);
  return rows;
}

app.post('/api/checkout/pos', async (req, res) => {
  try { res.json(await runCheckout('salefront', req.body, actor(req))); }
  catch (e) {
    if (e.message === 'INSUFFICIENT_STOCK') return res.status(409).json({ error: 'Insufficient stock', material: e.material });
    if (e.message === 'REDEMPTION_INVALID') return res.status(409).json({ error: 'Redemption code already used or expired.' });
    res.status(500).json({ error: e.message });
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
    if (r.expires_at && r.expires_at < new Date().toISOString()) {
      await updateRow('redemptions', r.id, { status: 'expired' });
      return res.status(404).json({ error: 'Code expired.' });
    }
    const promo = await getRow('promotions', r.promotion_id);
    res.json({ id: r.id, code: r.code, customer_name: r.customer_name, customer_id: r.customer_id,
      promotion_id: r.promotion_id, max_free_value: promo ? promo.max_free_value : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/checkout/delivery', async (req, res) => {
  try { res.json(await runCheckout('saledelivery', req.body, actor(req))); }
  catch (e) {
    if (e.message === 'INSUFFICIENT_STOCK') return res.status(409).json({ error: 'Insufficient stock', material: e.material });
    res.status(500).json({ error: e.message });
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
          const mat = await getRow('materials', r.material_id, client);
          if (!mat) continue;
          await updateRow('materials', r.material_id, { current_stock: mat.current_stock - r.qty }, client);
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
    res.status(500).json({ error: e.message });
  }
});

// ---- Expense + optional restock (transactional) --------------------------
// body: { expense:{...}, restock:{material_id, increment}|null, client_txn_id? }
app.post('/api/expense', async (req, res) => {
  const { expense, restock, client_txn_id } = req.body;
  try {
    const row = await withTransaction(async (client) => {
      if (!(await claimTxn(client_txn_id, client))) return { duplicate: true }; // already synced
      const row = await insertRow('expenses', expense, client);
      if (restock && restock.material_id) {
        const mat = await getRow('materials', restock.material_id, client);
        if (mat) {
          await updateRow('materials', restock.material_id, { current_stock: mat.current_stock + restock.increment }, client);
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// ---- Generic CRUD (registered last so specific routes take priority) -----
app.get('/api/:table', async (req, res) => {
  const { table } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  try { res.json(await listRows(table)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/:table', async (req, res) => {
  const { table } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  try {
    const data = { ...req.body };
    if (table === 'users' && data.password) data.password = await hashPassword(data.password);
    const row = await insertRow(table, data);
    if (table !== 'systemlog') await logActivity(actor(req), 'DB INSERT', `${table}: ${JSON.stringify(data).slice(0, 120)}`);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  try {
    const data = { ...req.body };
    if (table === 'users') {
      if (data.password) data.password = await hashPassword(data.password);
      else delete data.password; // keep existing when blank
    }
    const row = await updateRow(table, id, data);
    if (table !== 'systemlog') await logActivity(actor(req), 'DB UPDATE', `${table}#${id}`);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  if (!valid(table)) return res.status(404).json({ error: 'Unknown table' });
  try {
    await deleteRow(table, id);
    if (table !== 'systemlog') await logActivity(actor(req), 'DB DELETE', `${table}#${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback: serve index.html for any non-API route (client-side routing).
if (fs.existsSync(CLIENT_DIST)) {
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SMA V08 hub API running on http://localhost:${PORT}`));
