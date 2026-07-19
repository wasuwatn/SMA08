// Cross-cutting helpers shared by multiple route modules (server/routes/*).
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
import jwt from 'jsonwebtoken';
import { pool, TABLE_CONFIG } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set (check server/.env or the host\'s env vars).');
  process.exit(1);
}
export const TOKEN_TTL = '12h';
export const PIN_RE = /^\d{4}$/;

export const valid = (t) => Object.prototype.hasOwnProperty.call(TABLE_CONFIG, t);

// 500s log the real error server-side but never echo it to the client —
// raw pg/driver messages leak schema and connection details.
export const fail = (res, e) => {
  console.error(e);
  res.status(500).json({ error: 'Internal server error.' });
};

// All routes below require a valid STAFF token. Customer tokens are rejected
// here so they can't reach the generic CRUD / checkout routes.
export function staffAuthGuard(req, res, next) {
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
}

export const actor = (req) => req.user?.username || 'system';
export const isAdmin = (req) => req.user?.role === 'Admin';

// ---- Table-level write authorization --------------------------------------
// Mirrors the access flags in users.access that the client uses to hide pages;
// before this map existed the flags were cosmetic — any staff token could write
// any table (including users, i.e. self-promote to Admin). Reads stay open to
// all staff (dashboards need them), except the users table.
export const TABLE_ACCESS = {
  users: 'ADMIN', systemlog: 'ADMIN', processed_txns: 'ADMIN',
  settings: 'settings', promotions: 'promotions',
  materials: 'materials', menuname: 'bom', bom: 'bom', childmenu: 'bom',
  packagingbom: 'bom', matprepbom: 'bom', addons: 'bom', categories: 'bom',
  menu_modifiers: 'bom',
  customers: 'customers', redemptions: 'pos', salefront: 'pos', shifts: 'pos',
  point_ledger: 'points',
  saledelivery: 'delivery', deliverydaily: 'delivery', deliverymenu: 'delivery',
  stocklog: 'stock', expenses: 'expenses'
};

export function canWrite(req, table) {
  if (isAdmin(req)) return true;
  const need = TABLE_ACCESS[table];
  if (!need || need === 'ADMIN') return false;
  return String(req.user?.access || '').split(',').map(s => s.trim()).includes(need);
}

export const forbidden = (res) => res.status(403).json({ error: 'You do not have permission for this action.' });

// Active points promotion: buy_qty = points per free cup, max_free_value =
// price ceiling for the free cup. The only loyalty type since the rework from
// automatic stamps to shop-issued point links.
export async function activePointsPromotion() {
  const { rows } = await pool.query(
    "SELECT * FROM promotions WHERE type = 'points' AND status = 'Active' ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

// Point balance = every claimed ledger row (grants positive, spends negative).
// Pending link rows have no customer_id and never count.
export async function pointsBalanceFor(customerId, client = pool) {
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
export async function redemptionAvailability(customerId, promotion, client = pool) {
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

// Advisory-lock namespace for per-customer point spends (two-arg form:
// key1 = this constant, key2 = customer_id), same idea as SHIFT_LOCK_KEY.
export const POINTS_LOCK_KEY = 823402;
