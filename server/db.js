// SMA V08 - Postgres (Supabase) database: schema, seed data and generic CRUD helpers.
import 'dotenv/config';
import { Pool, types } from 'pg';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// DATE columns default to parsing into a JS Date object, which then
// JSON-serializes as a full "YYYY-MM-DDT00:00:00.000Z" timestamp — every
// day-string comparison in the client (today(), CSV export, exact-match
// filters) expects a bare "YYYY-MM-DD". Keep DATE as the raw wire string
// (already "YYYY-MM-DD") instead. TIMESTAMPTZ is left as a Date object: it
// JSON-serializes to the same ISO format the client already wrote via
// `new Date().toISOString()`, so no callers need to change.
types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; PGSSLMODE=disable lets a local dev Postgres work.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  // Without a cap, a bad DATABASE_URL (wrong host/port, blocked egress) hangs
  // forever with no error — the host just looks like it never started.
  connectionTimeoutMillis: 10000
});

// Runs fn(client) inside BEGIN/COMMIT, rolling back on error.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Legacy hash used by older versions of this app (SHA-256, no salt).
// Kept only to verify and migrate pre-existing accounts on their next login.
export function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

export async function hashPassword(password) {
  return bcrypt.hash(String(password), 10);
}

// Returns { ok, needsRehash } - ok is true if `password` matches `storedHash`,
// which may be a bcrypt hash or a legacy SHA-256 hash.
export async function verifyPassword(password, storedHash) {
  if (!storedHash) return { ok: false, needsRehash: false };
  if (storedHash.startsWith('$2')) {
    return { ok: await bcrypt.compare(String(password), storedHash), needsRehash: false };
  }
  const ok = legacySha256(password) === storedHash;
  return { ok, needsRehash: ok };
}

/*
 * Table configuration.
 *  - pk: primary key column
 *  - auto: true => integer pk auto-assigned by Postgres (SERIAL) when omitted
 *  - columns: ordered list of all columns (used for generic CRUD)
 */
export const TABLE_CONFIG = {
  users: {
    pk: 'username', auto: false,
    columns: ['username', 'password', 'role', 'access'],
    ddl: `CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, password TEXT, role TEXT, access TEXT)`
  },
  // current_theme was dropped (Phase-1 cleanup below) — theme now lives in
  // localStorage only (see chooseTheme() in Settings.jsx).
  settings: {
    pk: 'id', auto: true,
    columns: ['id', 'sweetness_levels', 'buyers', 'logo',
      'shop_name', 'shop_address', 'shop_phone', 'promptpay_id', 'receipt_footer'],
    ddl: `CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY, sweetness_levels TEXT, buyers TEXT, logo TEXT,
      shop_name TEXT, shop_address TEXT, shop_phone TEXT, promptpay_id TEXT, receipt_footer TEXT)`
  },
  materials: {
    pk: 'id', auto: false,
    columns: ['id', 'category', 'brand', 'item', 'qty', 'unit', 'price', 'yield',
      'current_stock', 'min_stock', 'status', 'mat_barcode', 'name', 'unit_price'],
    ddl: `CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, category TEXT, brand TEXT, item TEXT, qty DOUBLE PRECISION, unit TEXT,
      price DOUBLE PRECISION, yield DOUBLE PRECISION, current_stock DOUBLE PRECISION, min_stock DOUBLE PRECISION, status TEXT,
      mat_barcode TEXT, name TEXT, unit_price DOUBLE PRECISION)`
  },
  // Menu category names (the free-text menuname.category column is left as-is
  // for backward compatibility — this table just gives Settings a proper
  // add/edit/delete list to pick categories from instead of retyping them).
  categories: {
    pk: 'id', auto: true,
    columns: ['id', 'name'],
    ddl: `CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT)`
  },
  menuname: {
    pk: 'id', auto: false,
    columns: ['id', 'name', 'category', 'front_price', 'delivery_price', 'status'],
    ddl: `CREATE TABLE IF NOT EXISTS menuname (
      id TEXT PRIMARY KEY, name TEXT, category TEXT, front_price DOUBLE PRECISION,
      delivery_price DOUBLE PRECISION, status TEXT)`
  },
  // `material_id` is a tagged reference disambiguated by its id prefix:
  //   MAT…  → a real row in `materials`
  //   PBOM… → a packaging set in `packagingbom` (expanded into its component materials)
  //   MPRE… → a mat-prep set in `matprepbom` (expanded likewise)
  // See expandSetItems()/computeRequirements() in client/src/lib/helpers.js.
  bom: {
    pk: 'id', auto: true,
    columns: ['id', 'menu_name', 'menu_id', 'material_id', 'qty_used'],
    ddl: `CREATE TABLE IF NOT EXISTS bom (
      id SERIAL PRIMARY KEY, menu_name TEXT, menu_id TEXT, material_id TEXT, qty_used DOUBLE PRECISION)`
  },
  packagingbom: {
    pk: 'id', auto: false,
    columns: ['id', 'name', 'items'],
    ddl: `CREATE TABLE IF NOT EXISTS packagingbom (
      id TEXT PRIMARY KEY, name TEXT, items TEXT)`
  },
  matprepbom: {
    pk: 'id', auto: false,
    columns: ['id', 'name', 'items'],
    ddl: `CREATE TABLE IF NOT EXISTS matprepbom (
      id TEXT PRIMARY KEY, name TEXT, items TEXT)`
  },
  // `kind` groups a modifier by role: 'container' (Ice/Hot/Bottle) and
  // 'sweetness' (0%/25%/... ) are each a required, single-select choice per
  // cup — POS.jsx reads them the same way it always read the old hardcoded
  // CONTAINERS array / settings.sweetness_levels CSV, just sourced from here
  // now so staff can add/edit/remove them like any other modifier. 'extra'
  // (the default/legacy value) is the original optional, multi-select add-on
  // list (e.g. "Extra pearls") — unchanged behavior.
  addons: {
    pk: 'id', auto: true,
    columns: ['id', 'name', 'price_change', 'kind'],
    ddl: `CREATE TABLE IF NOT EXISTS addons (
      id SERIAL PRIMARY KEY, name TEXT, price_change DOUBLE PRECISION, kind TEXT DEFAULT 'extra')`
  },
  // Self-redeem codes minted by a customer in the LINE portal. A staff member
  // enters the code at POS, which marks it 'used' inside the checkout txn. One
  // pending code reserves one earned free-cup credit so it can't be over-minted.
  redemptions: {
    pk: 'id', auto: true,
    columns: ['id', 'code', 'customer_id', 'customer_name', 'promotion_id', 'status',
      'created_at', 'expires_at', 'used_at', 'used_order_no'],
    ddl: `CREATE TABLE IF NOT EXISTS redemptions (
      id SERIAL PRIMARY KEY, code TEXT, customer_id INTEGER, customer_name TEXT,
      promotion_id INTEGER, status TEXT, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ, used_order_no TEXT)`
  },
  // Shop-issued loyalty points. One row per event, signed `points`:
  //   kind 'link'  — a claim link the shop hands out; starts status 'pending'
  //                  with a unique token, flips to 'claimed' when a customer
  //                  opens it (single-use, no expiry).
  //   kind 'crm'   — direct grant from the CRM page (inserted already 'claimed').
  //   kind 'spend' — negative row written by POS checkout for a point-funded
  //                  free cup (also 'claimed', carries the order_no).
  // Balance = SUM(points) WHERE customer_id = X AND status = 'claimed'.
  point_ledger: {
    pk: 'id', auto: true,
    columns: ['id', 'token', 'customer_id', 'points', 'kind', 'status', 'note',
      'created_by', 'created_at', 'claimed_at', 'order_no'],
    ddl: `CREATE TABLE IF NOT EXISTS point_ledger (
      id SERIAL PRIMARY KEY, token TEXT, customer_id INTEGER, points INTEGER,
      kind TEXT, status TEXT, note TEXT, created_by TEXT,
      created_at TIMESTAMPTZ, claimed_at TIMESTAMPTZ, order_no TEXT)`
  },
  // Promotion rules. `type: 'points'` (buy_qty = points per free cup, capped at
  // max_free_value) is the active loyalty type; 'stamp' rows are legacy.
  // `config` is reserved JSON for future promotion types (percent discount,
  // buy-X-get-Y, etc.) without a schema change.
  promotions: {
    pk: 'id', auto: true,
    columns: ['id', 'name', 'type', 'status', 'buy_qty', 'free_qty', 'max_free_value', 'config'],
    ddl: `CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY, name TEXT, type TEXT, status TEXT,
      buy_qty INTEGER, free_qty INTEGER, max_free_value DOUBLE PRECISION, config TEXT)`
  },
  customers: {
    pk: 'id', auto: true,
    columns: ['id', 'name', 'address', 'gender', 'phone', 'line_user_id', 'code', 'date_of_birth', 'favorite_menu'],
    ddl: `CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY, name TEXT, address TEXT, gender TEXT,
      phone TEXT, line_user_id TEXT, code TEXT, date_of_birth TEXT, favorite_menu TEXT)`
  },
  // customer_id is a real INTEGER FK, added (and backfilled from customer_name)
  // by migrate()'s Phase-2 below rather than the ddl, so it gets the same type
  // whether the table is brand new or already existed. payment_method/shift_id
  // are plain TEXT, picked up by the generic "add missing columns" loop.
  salefront: {
    pk: 'id', auto: true,
    columns: ['id', 'date', 'customer_name', 'customer_address', 'customer_id', 'menu_name', 'variant', 'quantity',
      'sweetness', 'container', 'addons', 'addon_price', 'total_price', 'cashier', 'order_no',
      'order_type', 'delivery_platform', 'is_free', 'promotion_id', 'payment_method', 'shift_id', 'status'],
    // `status` is NULL for a normal sale; a voided bill sets every one of its
    // cups to 'void'. Voided rows stay in the table (soft void — visible in
    // history, recoverable) but are excluded from every total/count/report, so
    // all aggregations must filter them out null-safely (status IS DISTINCT
    // FROM 'void').
    ddl: `CREATE TABLE IF NOT EXISTS salefront (
      id SERIAL PRIMARY KEY, date DATE, customer_name TEXT,
      customer_address TEXT, menu_name TEXT, variant TEXT, quantity INTEGER, sweetness TEXT,
      container TEXT, addons TEXT, addon_price DOUBLE PRECISION, total_price DOUBLE PRECISION, cashier TEXT,
      order_no TEXT, order_type TEXT, delivery_platform TEXT, is_free TEXT, promotion_id TEXT, status TEXT)`
  },
  childmenu: {
    pk: 'id', auto: true,
    columns: ['id', 'menu_name', 'menu_id', 'name', 'material_id', 'qty_used', 'price_change'],
    ddl: `CREATE TABLE IF NOT EXISTS childmenu (
      id SERIAL PRIMARY KEY, menu_name TEXT, name TEXT,
      material_id TEXT, qty_used DOUBLE PRECISION, price_change DOUBLE PRECISION DEFAULT 0)`
  },
  saledelivery: {
    pk: 'id', auto: true,
    columns: ['id', 'date', 'customer_name', 'customer_address', 'customer_id', 'raw_order_string',
      'base_price', 'discount_tier1', 'discount_type1', 'discount_tier2', 'discount_type2',
      'discount_tier3', 'discount_type3', 'ad_cost', 'gp_amount', 'net_price', 'status', 'cashier',
      'addons', 'addon_price'],
    ddl: `CREATE TABLE IF NOT EXISTS saledelivery (
      id SERIAL PRIMARY KEY, date DATE, customer_name TEXT,
      customer_address TEXT, raw_order_string TEXT, base_price DOUBLE PRECISION,
      discount_tier1 TEXT, discount_type1 TEXT, discount_tier2 TEXT, discount_type2 TEXT,
      discount_tier3 TEXT, discount_type3 TEXT, ad_cost DOUBLE PRECISION, gp_amount DOUBLE PRECISION,
      net_price DOUBLE PRECISION, status TEXT, cashier TEXT, addons TEXT, addon_price DOUBLE PRECISION)`
  },
  stocklog: {
    pk: 'id', auto: true,
    columns: ['id', 'date', 'material_id', 'action', 'qty_changed', 'note'],
    ddl: `CREATE TABLE IF NOT EXISTS stocklog (
      id SERIAL PRIMARY KEY, date DATE, material_id TEXT, action TEXT,
      qty_changed DOUBLE PRECISION, note TEXT)`
  },
  // Daily delivery sales summary imported from the Wongnai report (one row per
  // day). `gross_sales` is after customer discounts but before the platform GP
  // commission; `gp_amount` / `net_sales` are derived on import.
  deliverydaily: {
    pk: 'id', auto: true,
    columns: ['id', 'date', 'gross_sales', 'orders', 'avg_basket', 'gp_amount', 'net_sales', 'source', 'note'],
    ddl: `CREATE TABLE IF NOT EXISTS deliverydaily (
      id SERIAL PRIMARY KEY, date DATE, gross_sales DOUBLE PRECISION, orders INTEGER,
      avg_basket DOUBLE PRECISION, gp_amount DOUBLE PRECISION, net_sales DOUBLE PRECISION,
      source TEXT, note TEXT)`
  },
  // Per-menu delivery breakdown for an imported period (full menu price; drives
  // top-drinks and material deduction). qty = cups sold over [period_start, period_end].
  deliverymenu: {
    pk: 'id', auto: true,
    columns: ['id', 'period_start', 'period_end', 'menu_name', 'qty', 'sales', 'source'],
    ddl: `CREATE TABLE IF NOT EXISTS deliverymenu (
      id SERIAL PRIMARY KEY, period_start DATE, period_end DATE, menu_name TEXT,
      qty DOUBLE PRECISION, sales DOUBLE PRECISION, source TEXT)`
  },
  // `replenishments` was dropped (Phase-1 cleanup below) — superseded by
  // stocklog and never read/written by the client.
  // `material_id` here is a real FK (Phase-2), backfilled from mat_barcode;
  // `replenishment_id` was dropped along with the dead table above.
  expenses: {
    pk: 'id', auto: true,
    columns: ['id', 'date', 'description', 'amount', 'buyer', 'mat_barcode', 'material_id',
      'qty', 'unit', 'price', 'category', 'discount', 'shipping_cost', 'note'],
    ddl: `CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY, date DATE, description TEXT, amount DOUBLE PRECISION,
      buyer TEXT, mat_barcode TEXT, qty DOUBLE PRECISION, unit TEXT,
      price DOUBLE PRECISION, category TEXT, discount DOUBLE PRECISION, shipping_cost DOUBLE PRECISION, note TEXT)`
  },
  // Cash-register shifts. One shift may be open at a time; closing aggregates
  // that shift's salefront rows by payment method into a Z-report snapshot.
  shifts: {
    pk: 'id', auto: true,
    columns: ['id', 'status', 'opened_at', 'opened_by', 'opening_cash',
      'closed_at', 'closed_by', 'closing_cash', 'expected_cash', 'cash_sales',
      'promptpay_sales', 'transfer_sales', 'orders', 'over_short', 'note'],
    ddl: `CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY, status TEXT, opened_at TIMESTAMPTZ, opened_by TEXT,
      opening_cash DOUBLE PRECISION, closed_at TIMESTAMPTZ, closed_by TEXT,
      closing_cash DOUBLE PRECISION, expected_cash DOUBLE PRECISION,
      cash_sales DOUBLE PRECISION, promptpay_sales DOUBLE PRECISION,
      transfer_sales DOUBLE PRECISION, orders INTEGER, over_short DOUBLE PRECISION, note TEXT)`
  },
  systemlog: {
    pk: 'id', auto: true,
    columns: ['id', 'created_at', 'username', 'activity', 'details'],
    ddl: `CREATE TABLE IF NOT EXISTS systemlog (
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ, username TEXT,
      activity TEXT, details TEXT)`
  },
  // Idempotency guard for offline-synced writes. The client sends a stable
  // client_txn_id per sale/expense; the first time we see it we record it here,
  // so a re-sent (retried) request becomes a no-op instead of a duplicate row.
  processed_txns: {
    pk: 'id', auto: false,
    columns: ['id', 'created_at'],
    ddl: `CREATE TABLE IF NOT EXISTS processed_txns (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ)`
  },
  // "Pending slip" bucket for the LINE x Make.com receipt-OCR expense intake
  // (see INTEGRATION_PLAN.md Phase 1). Make.com posts a row here after OCR;
  // `confirm_token` gates both the read and the confirm write so the LIFF
  // review page needs no separate login — the token IS the auth for that one
  // slip. `line_message_id` is UNIQUE so a retried webhook delivery can't
  // create a second pending row for the same physical slip. `expense_id` is
  // filled in once the slip is confirmed and turned into a real `expenses` row.
  pending_slips: {
    pk: 'id', auto: true,
    columns: ['id', 'line_message_id', 'line_user_id', 'amount', 'merchant', 'category',
      'slip_image_url', 'ocr_raw', 'status', 'confirm_token', 'expense_id', 'created_at', 'confirmed_at'],
    ddl: `CREATE TABLE IF NOT EXISTS pending_slips (
      id SERIAL PRIMARY KEY, line_message_id TEXT UNIQUE, line_user_id TEXT,
      amount DOUBLE PRECISION DEFAULT 0, merchant TEXT, category TEXT,
      slip_image_url TEXT, ocr_raw TEXT, status TEXT DEFAULT 'pending',
      confirm_token TEXT, expense_id INTEGER, created_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ)`
  }
};

// Claims a client_txn_id inside an open transaction. Returns true if this is the
// first time we see it (caller should proceed), false if already processed (skip).
export async function claimTxn(txnId, client) {
  if (!txnId) return true; // online writes without an id are always processed
  const r = await client.query(
    'INSERT INTO processed_txns (id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [txnId, new Date().toISOString()]
  );
  return r.rowCount > 0;
}

export const TABLES = Object.keys(TABLE_CONFIG);

// ---- Generic CRUD helpers ------------------------------------------------
// All helpers accept an optional `client` (defaults to the shared pool) so
// they can participate in a withTransaction() block.

export async function listRows(table, client = pool) {
  const result = await client.query(`SELECT * FROM ${table}`);
  return result.rows;
}

export async function insertRow(table, data, client = pool) {
  const cfg = TABLE_CONFIG[table];
  const cols = cfg.columns.filter(c => {
    if (c === cfg.pk && cfg.auto && isEmpty(data[c])) return false;
    return data[c] !== undefined;
  });
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const values = cols.map(c => normalize(data[c], c));
  const result = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return result.rows[0];
}

export async function getRow(table, id, client = pool) {
  const cfg = TABLE_CONFIG[table];
  const result = await client.query(`SELECT * FROM ${table} WHERE ${cfg.pk} = $1`, [id]);
  return result.rows[0];
}

export async function updateRow(table, id, data, client = pool) {
  const cfg = TABLE_CONFIG[table];
  const cols = cfg.columns.filter(c => c !== cfg.pk && data[c] !== undefined);
  if (cols.length) {
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map(c => normalize(data[c], c));
    await client.query(`UPDATE ${table} SET ${setClause} WHERE ${cfg.pk} = $${cols.length + 1}`, [...values, id]);
  }
  return getRow(table, id, client);
}

export async function deleteRow(table, id, client = pool) {
  const cfg = TABLE_CONFIG[table];
  await client.query(`DELETE FROM ${table} WHERE ${cfg.pk} = $1`, [id]);
}

// Atomically adjust a material's stock by `delta` (negative = deduct). The
// read-modify-write this replaces could lose updates when two POS devices
// checked out at the same time. With guard=true the deduction only applies if
// enough stock remains. Returns:
//   { ok: true,  item }          — adjusted
//   { ok: false, missing: true } — material doesn't exist (caller skips)
//   { ok: false, item }          — guard blocked it (insufficient stock)
export async function adjustStock(materialId, delta, { client = pool, guard = false } = {}) {
  const sql = guard
    ? 'UPDATE materials SET current_stock = current_stock + $1 WHERE id = $2 AND current_stock + $1 >= 0 RETURNING item'
    : 'UPDATE materials SET current_stock = current_stock + $1 WHERE id = $2 RETURNING item';
  const r = await client.query(sql, [delta, materialId]);
  if (r.rowCount) return { ok: true, item: r.rows[0].item };
  const existing = await client.query('SELECT item FROM materials WHERE id = $1', [materialId]);
  if (!existing.rowCount) return { ok: false, missing: true };
  return { ok: false, missing: false, item: existing.rows[0].item };
}

function isEmpty(v) { return v === undefined || v === null || v === ''; }

// Columns holding DATE/TIMESTAMPTZ values, by this schema's naming convention:
// day fields are "date"/"period_start"/"period_end", timestamps end in "_at".
const isTemporalColumn = (col) =>
  col === 'date' || col === 'period_start' || col === 'period_end' || col.endsWith('_at');

function normalize(v, col) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  // '' is a normal value for a TEXT column but invalid input for DATE/TIMESTAMPTZ.
  if (v === '' && col && isTemporalColumn(col)) return null;
  return v;
}

export async function logActivity(username, activity, details = '') {
  await insertRow('systemlog', {
    created_at: new Date().toISOString(),
    username: username || 'system',
    activity,
    details: String(details).substring(0, 200)
  });
}

// ---- Schema creation + seeding ------------------------------------------

export async function initDb() {
  for (const t of TABLES) await pool.query(TABLE_CONFIG[t].ddl);
  // One order (= one POS checkout) gets one number, shared by every cup row it produced.
  await pool.query('CREATE SEQUENCE IF NOT EXISTS salefront_order_seq');
  await migrate();
  await migrateColumnTypes();
  await createIndexes();
  await seed();
}

// Databases created before this version stored every date/timestamp as TEXT.
// Upgrade them to real DATE/TIMESTAMPTZ columns (matching the ddl above) so
// range queries (?since/?until) and ORDER BY work correctly instead of doing
// lexicographic string comparison. NULLIF(...,'') guards old blank strings —
// plain ::date/::timestamptz would reject '' as invalid input. Idempotent: once
// a column is no longer 'text' this is a no-op, so it's cheap to run every boot.
const COLUMN_TYPE_MIGRATIONS = [
  ['salefront', 'date', 'date'], ['saledelivery', 'date', 'date'],
  ['stocklog', 'date', 'date'], ['expenses', 'date', 'date'],
  ['deliverydaily', 'date', 'date'],
  ['deliverymenu', 'period_start', 'date'], ['deliverymenu', 'period_end', 'date'],
  ['systemlog', 'created_at', 'timestamptz'], ['processed_txns', 'created_at', 'timestamptz'],
  ['redemptions', 'created_at', 'timestamptz'], ['redemptions', 'expires_at', 'timestamptz'],
  ['redemptions', 'used_at', 'timestamptz'],
  ['shifts', 'opened_at', 'timestamptz'], ['shifts', 'closed_at', 'timestamptz']
];

async function migrateColumnTypes() {
  for (const [table, column, type] of COLUMN_TYPE_MIGRATIONS) {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (rows[0]?.data_type !== 'text') continue; // already migrated (or column absent)
    try {
      await pool.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING NULLIF(${column}, '')::${type}`
      );
    } catch (e) {
      console.error(`Column-type migration failed for ${table}.${column} -> ${type}:`, e.message);
    }
  }
}

// Hot lookup paths: dashboard date windows, loyalty by customer, stock history,
// pending redeem codes. Runs after migrate() so new columns already exist.
async function createIndexes() {
  const stmts = [
    'CREATE INDEX IF NOT EXISTS idx_salefront_date ON salefront (date)',
    'CREATE INDEX IF NOT EXISTS idx_salefront_customer_name ON salefront (lower(customer_name))',
    'CREATE INDEX IF NOT EXISTS idx_salefront_customer_id ON salefront (customer_id)',
    'CREATE INDEX IF NOT EXISTS idx_salefront_shift ON salefront (shift_id)',
    'CREATE INDEX IF NOT EXISTS idx_stocklog_material ON stocklog (material_id)',
    // UNIQUE (not just an index): the redeem endpoint retries on a 23505
    // collision, but that only works if the DB actually rejects duplicates —
    // two pending codes with the same 6 digits must never coexist.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_redemptions_pending_code ON redemptions (code) WHERE status = 'pending'",
    // Claim links must be unique; crm/spend rows have no token (NULL is exempt).
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_point_ledger_token ON point_ledger (token) WHERE token IS NOT NULL',
    'CREATE INDEX IF NOT EXISTS idx_point_ledger_customer ON point_ledger (customer_id)',
    "CREATE INDEX IF NOT EXISTS idx_pending_slips_status ON pending_slips (status)"
  ];
  for (const s of stmts) await pool.query(s);
}

// Add any columns present in TABLE_CONFIG but missing from an existing table.
async function migrate() {
  // Phase-2 runs FIRST, before the generic loop below: customer_id/menu_id
  // need real types (INTEGER FK, not TEXT). The generic loop adds anything
  // still missing as TEXT, so if it ran first it would create these columns
  // as TEXT and the typed ALTER below would then no-op (IF NOT EXISTS) —
  // silently leaving them the wrong type forever.
  // All additive (nullable), backfilled once from matching names/barcodes.
  for (const sql of [
    'ALTER TABLE salefront ADD COLUMN IF NOT EXISTS customer_id INTEGER',
    'ALTER TABLE saledelivery ADD COLUMN IF NOT EXISTS customer_id INTEGER',
    'ALTER TABLE expenses ADD COLUMN IF NOT EXISTS material_id TEXT',
    'ALTER TABLE bom ADD COLUMN IF NOT EXISTS menu_id TEXT',
    'ALTER TABLE childmenu ADD COLUMN IF NOT EXISTS menu_id TEXT'
  ]) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }
  // One-time backfill: match existing name/barcode strings to their id.
  for (const sql of [
    `UPDATE salefront sf SET customer_id = c.id FROM customers c
       WHERE sf.customer_id IS NULL AND lower(sf.customer_name) = lower(c.name)`,
    `UPDATE saledelivery sd SET customer_id = c.id FROM customers c
       WHERE sd.customer_id IS NULL AND lower(sd.customer_name) = lower(c.name)`,
    `UPDATE expenses e SET material_id = m.id FROM materials m
       WHERE e.material_id IS NULL AND e.mat_barcode <> '' AND e.mat_barcode = m.mat_barcode`,
    `UPDATE bom b SET menu_id = m.id FROM menuname m
       WHERE b.menu_id IS NULL AND lower(b.menu_name) = lower(m.name)`,
    `UPDATE childmenu c SET menu_id = m.id FROM menuname m
       WHERE c.menu_id IS NULL AND lower(c.menu_name) = lower(m.name)`
  ]) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }

  for (const t of TABLES) {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]
    );
    const existing = rows.map(r => r.column_name);
    for (const col of TABLE_CONFIG[t].columns) {
      if (!existing.includes(col)) {
        try { await pool.query(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT`); } catch { /* ignore */ }
      }
    }
  }

  // Phase-1 cleanup: drop dead objects that never carried live data.
  //  - `replenishments` was superseded by stocklog and never read/written.
  //  - `expenses.replenishment_id` was always null (referred to the dead table).
  //  - `settings.current_theme` was write-only; theme lives in localStorage.
  // All guarded with IF EXISTS so this stays idempotent across boots.
  for (const sql of [
    'DROP TABLE IF EXISTS replenishments',
    'ALTER TABLE expenses DROP COLUMN IF EXISTS replenishment_id',
    'ALTER TABLE settings DROP COLUMN IF EXISTS current_theme'
  ]) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }

  // Phase-3: staff-assigned customer code (1 letter + 3 digits), unique so it can
  // reliably identify a customer regardless of what nickname they use on LINE.
  // Normalize the old free-text gender values ('male'/'female') to the M/F/NA
  // codes used going forward.
  for (const sql of [
    'ALTER TABLE customers ADD CONSTRAINT customers_code_unique UNIQUE (code)',
    "UPDATE customers SET gender = 'M' WHERE lower(gender) = 'male'",
    "UPDATE customers SET gender = 'F' WHERE lower(gender) = 'female'"
  ]) {
    try { await pool.query(sql); } catch { /* ignore (constraint already exists, etc.) */ }
  }

  // Phase-5: the legacy automatic stamp-card promotion type is gone — the
  // Promotions UI no longer offers it, and the server only ever reads
  // type='points'. Any shop whose database predates this rework may still
  // have an old type='stamp' row; convert it in place (buy_qty/max_free_value
  // mean the same thing for both types) so it becomes the active points promo
  // without the owner having to recreate it by hand.
  try {
    await pool.query("UPDATE promotions SET type = 'points' WHERE type = 'stamp'");
  } catch { /* ignore */ }

  // Phase-6: addons.kind existing rows predate the column (added as plain
  // TEXT with no default by the generic loop above) — backfill them to the
  // 'extra' meaning they always had. Then seed the container/sweetness
  // modifier rows once, converting the old hardcoded CONTAINERS array and
  // the settings.sweetness_levels CSV into real addons rows — only if a shop
  // has none yet, so this never overwrites values staff already edited.
  try {
    await pool.query("UPDATE addons SET kind = 'extra' WHERE kind IS NULL");
    const { rows: [{ c: containerCount }] } = await pool.query("SELECT COUNT(*)::int AS c FROM addons WHERE kind = 'container'");
    if (containerCount === 0) {
      for (const [name, price_change] of [['Ice', 0], ['Hot', 0], ['Bottle', -5]]) {
        await pool.query('INSERT INTO addons (name, price_change, kind) VALUES ($1, $2, $3)', [name, price_change, 'container']);
      }
    }
    const { rows: [{ c: sweetnessCount }] } = await pool.query("SELECT COUNT(*)::int AS c FROM addons WHERE kind = 'sweetness'");
    if (sweetnessCount === 0) {
      const { rows: [settingsRow] } = await pool.query('SELECT sweetness_levels FROM settings LIMIT 1');
      const levels = String(settingsRow?.sweetness_levels || 'No Sweet, 25%, 50%, 100%')
        .split(',').map(s => s.trim()).filter(Boolean);
      for (const name of levels) {
        await pool.query('INSERT INTO addons (name, price_change, kind) VALUES ($1, $2, $3)', [name, 0, 'sweetness']);
      }
    }
  } catch (e) {
    console.error('addons.kind seed migration failed:', e.message);
  }

  // Phase-4: Supabase flags any table without RLS as "Unrestricted" in its
  // dashboard. That only matters for Supabase's own REST/GraphQL API
  // (PostgREST) — this hub never uses it (it talks to Postgres directly via
  // DATABASE_URL, a superuser role that bypasses RLS regardless). Enabling
  // RLS with no policies closes that alternate access path with zero effect
  // on the app itself.
  for (const sql of TABLES.map(t => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)) {
    try { await pool.query(sql); } catch { /* ignore */ }
  }
}

async function seed() {
  const { rows } = await pool.query('SELECT COUNT(*) c FROM users');
  if (Number(rows[0].c) > 0) return; // already seeded

  await withTransaction(async (client) => {
    await insertRow('users', {
      username: 'admin', password: await hashPassword('admin'),
      access: 'dashboard,pos,delivery,materials,stock,bom,expenses,customers,users,daily,settings,promotions,points',
      role: 'Admin'
    }, client);
    await insertRow('users', {
      username: 'staff', password: await hashPassword('staff'),
      access: 'dashboard,pos,delivery,customers,daily,settings', role: 'User'
    }, client);

    await insertRow('settings', {
      sweetness_levels: 'No Sweet, 25%, 50%, 100%',
      buyers: 'Admin, Staff, Buyer A', logo: null
    }, client);

    const materials = [
      { id: 'MAT001', category: 'Beans', brand: 'Arabica Premium', item: 'Beans 500g', qty: 500, unit: 'g', price: 350, yield: 95, current_stock: 5000, min_stock: 1000, status: 'Active', mat_barcode: '8850123456789', name: 'Arabica Premium Beans 500g', unit_price: 0.737 },
      { id: 'MAT002', category: 'Dairy', brand: 'Meiji', item: 'Milk 2L', qty: 2000, unit: 'ml', price: 95, yield: 100, current_stock: 10000, min_stock: 2000, status: 'Active', mat_barcode: '8850123456790', name: 'Meiji Milk 2L', unit_price: 0.0475 },
      { id: 'MAT003', category: 'Powder', brand: 'Van Houten', item: 'Cocoa 500g', qty: 500, unit: 'g', price: 280, yield: 98, current_stock: 2000, min_stock: 500, status: 'Active', mat_barcode: '8850123456791', name: 'Van Houten Cocoa 500g', unit_price: 0.571 },
      { id: 'MAT004', category: 'Sweetener', brand: 'Mitr Phol', item: 'Syrup 1L', qty: 1000, unit: 'ml', price: 60, yield: 100, current_stock: 5000, min_stock: 1000, status: 'Active', mat_barcode: '8850123456792', name: 'Mitr Phol Syrup 1L', unit_price: 0.06 },
      { id: 'MAT005', category: 'Packaging', brand: 'KOTEA', item: 'Cups 50pcs', qty: 50, unit: 'pcs', price: 75, yield: 100, current_stock: 500, min_stock: 100, status: 'Active', mat_barcode: '8850123456793', name: 'KOTEA Cups 50pcs', unit_price: 1.5 },
      { id: 'MAT006', category: 'Packaging', brand: 'KOTEA', item: 'Straws 100pcs', qty: 100, unit: 'pcs', price: 30, yield: 100, current_stock: 1000, min_stock: 200, status: 'Active', mat_barcode: '8850123456794', name: 'KOTEA Straws 100pcs', unit_price: 0.3 },
      { id: 'MAT007', category: 'Beans', brand: 'Robusta Dark', item: 'Beans 1kg', qty: 1000, unit: 'g', price: 420, yield: 92, current_stock: 3000, min_stock: 800, status: 'Active', mat_barcode: '8850123456795', name: 'Robusta Dark Beans 1kg', unit_price: 0.456 },
      { id: 'MAT008', category: 'Dairy', brand: 'Lactasoy', item: 'Oat Milk 1L', qty: 1000, unit: 'ml', price: 85, yield: 100, current_stock: 8000, min_stock: 1500, status: 'Active', mat_barcode: '8850123456796', name: 'Lactasoy Oat Milk 1L', unit_price: 0.085 },
      { id: 'MAT009', category: 'Tea', brand: 'Thai Tea', item: 'Tea Mix 500g', qty: 500, unit: 'g', price: 180, yield: 96, current_stock: 2500, min_stock: 600, status: 'Active', mat_barcode: '8850123456797', name: 'Thai Tea Mix 500g', unit_price: 0.375 },
      { id: 'MAT010', category: 'Powder', brand: 'Nestle', item: 'Malt Powder 500g', qty: 500, unit: 'g', price: 220, yield: 99, current_stock: 1800, min_stock: 400, status: 'Active', mat_barcode: '8850123456798', name: 'Nestle Malt Powder 500g', unit_price: 0.443 },
      { id: 'MAT011', category: 'Sweetener', brand: 'Golden Sugar', item: 'Brown Sugar 1kg', qty: 1000, unit: 'g', price: 45, yield: 100, current_stock: 4000, min_stock: 800, status: 'Active', mat_barcode: '8850123456799', name: 'Golden Sugar Brown Sugar 1kg', unit_price: 0.045 },
      { id: 'MAT012', category: 'Spices', brand: 'Thai Spice', item: 'Cardamom 100g', qty: 100, unit: 'g', price: 120, yield: 95, current_stock: 500, min_stock: 150, status: 'Active', mat_barcode: '8850123456800', name: 'Thai Spice Cardamom 100g', unit_price: 1.263 },
      { id: 'MAT013', category: 'Packaging', brand: 'PakLid', item: 'Lids 500pcs', qty: 500, unit: 'pcs', price: 90, yield: 100, current_stock: 800, min_stock: 200, status: 'Active', mat_barcode: '8850123456801', name: 'PakLid Lids 500pcs', unit_price: 0.18 },
      { id: 'MAT014', category: 'Beans', brand: 'Kenya AA', item: 'Beans 250g', qty: 250, unit: 'g', price: 280, yield: 94, current_stock: 2000, min_stock: 500, status: 'Active', mat_barcode: '8850123456802', name: 'Kenya AA Beans 250g', unit_price: 1.191 },
      { id: 'MAT015', category: 'Dairy', brand: 'Emborg', item: 'Milk Cream 200ml', qty: 200, unit: 'ml', price: 120, yield: 98, current_stock: 3000, min_stock: 600, status: 'Active', mat_barcode: '8850123456803', name: 'Emborg Milk Cream 200ml', unit_price: 0.612 },
      { id: 'MAT016', category: 'Tea', brand: 'Cha Yen', item: 'Cha Yen Mix 1kg', qty: 1000, unit: 'g', price: 320, yield: 95, current_stock: 1500, min_stock: 400, status: 'Active', mat_barcode: '8850123456804', name: 'Cha Yen Mix 1kg', unit_price: 0.337 },
      { id: 'MAT017', category: 'Powder', brand: 'Marigold', item: 'Matcha 250g', qty: 250, unit: 'g', price: 450, yield: 99, current_stock: 800, min_stock: 200, status: 'Active', mat_barcode: '8850123456805', name: 'Marigold Matcha 250g', unit_price: 1.818 },
      { id: 'MAT018', category: 'Sweetener', brand: 'Honey Pure', item: 'Honey 500ml', qty: 500, unit: 'ml', price: 180, yield: 100, current_stock: 1200, min_stock: 300, status: 'Active', mat_barcode: '8850123456806', name: 'Honey Pure Honey 500ml', unit_price: 0.36 },
      { id: 'MAT019', category: 'Spices', brand: 'Vanilla Box', item: 'Vanilla Extract 100ml', qty: 100, unit: 'ml', price: 250, yield: 100, current_stock: 400, min_stock: 100, status: 'Active', mat_barcode: '8850123456807', name: 'Vanilla Box Vanilla Extract 100ml', unit_price: 2.5 },
      { id: 'MAT020', category: 'Packaging', brand: 'EcoCup', item: 'Paper Cups 500pcs', qty: 500, unit: 'pcs', price: 110, yield: 100, current_stock: 600, min_stock: 150, status: 'Active', mat_barcode: '8850123456808', name: 'EcoCup Paper Cups 500pcs', unit_price: 0.22 },
      { id: 'MAT021', category: 'Beans', brand: 'Ethiopian Yirgacheffe', item: 'Beans 200g', qty: 200, unit: 'g', price: 320, yield: 93, current_stock: 1500, min_stock: 400, status: 'Active', mat_barcode: '8850123456809', name: 'Ethiopian Yirgacheffe Beans 200g', unit_price: 1.720 },
      { id: 'MAT022', category: 'Dairy', brand: 'Almond Pro', item: 'Almond Milk 1L', qty: 1000, unit: 'ml', price: 95, yield: 100, current_stock: 5000, min_stock: 1000, status: 'Active', mat_barcode: '8850123456810', name: 'Almond Pro Almond Milk 1L', unit_price: 0.095 },
      { id: 'MAT023', category: 'Tea', brand: 'Green Leaf', item: 'Green Tea 300g', qty: 300, unit: 'g', price: 150, yield: 97, current_stock: 1800, min_stock: 500, status: 'Active', mat_barcode: '8850123456811', name: 'Green Leaf Green Tea 300g', unit_price: 0.515 },
      { id: 'MAT024', category: 'Powder', brand: 'Choco Star', item: 'Chocolate Powder 1kg', qty: 1000, unit: 'g', price: 380, yield: 96, current_stock: 2200, min_stock: 600, status: 'Active', mat_barcode: '8850123456812', name: 'Choco Star Chocolate Powder 1kg', unit_price: 0.396 },
      { id: 'MAT025', category: 'Sweetener', brand: 'Stevia Sweet', item: 'Stevia 200g', qty: 200, unit: 'g', price: 140, yield: 100, current_stock: 900, min_stock: 250, status: 'Active', mat_barcode: '8850123456813', name: 'Stevia Sweet Stevia 200g', unit_price: 0.7 },
      { id: 'MAT026', category: 'Spices', brand: 'Cinnamon Gold', item: 'Cinnamon Stick 100g', qty: 100, unit: 'g', price: 180, yield: 96, current_stock: 600, min_stock: 200, status: 'Active', mat_barcode: '8850123456814', name: 'Cinnamon Gold Cinnamon Stick 100g', unit_price: 1.875 },
      { id: 'MAT027', category: 'Packaging', brand: 'SealPro', item: 'Cup Sleeves 1000pcs', qty: 1000, unit: 'pcs', price: 85, yield: 100, current_stock: 1500, min_stock: 300, status: 'Active', mat_barcode: '8850123456815', name: 'SealPro Cup Sleeves 1000pcs', unit_price: 0.085 },
      { id: 'MAT028', category: 'Beans', brand: 'Colombian Geisha', item: 'Beans 100g', qty: 100, unit: 'g', price: 400, yield: 91, current_stock: 800, min_stock: 300, status: 'Active', mat_barcode: '8850123456816', name: 'Colombian Geisha Beans 100g', unit_price: 4.396 },
      { id: 'MAT029', category: 'Dairy', brand: 'Coconut Rich', item: 'Coconut Milk 500ml', qty: 500, unit: 'ml', price: 55, yield: 100, current_stock: 3500, min_stock: 800, status: 'Active', mat_barcode: '8850123456817', name: 'Coconut Rich Coconut Milk 500ml', unit_price: 0.11 },
      { id: 'MAT030', category: 'Tea', brand: 'Jasmine Essence', item: 'Jasmine Tea 200g', qty: 200, unit: 'g', price: 160, yield: 95, current_stock: 1200, min_stock: 400, status: 'Active', mat_barcode: '8850123456818', name: 'Jasmine Essence Jasmine Tea 200g', unit_price: 0.842 },
      { id: 'MAT031', category: 'Powder', brand: 'Instant Coffee', item: 'Instant Coffee 250g', qty: 250, unit: 'g', price: 190, yield: 100, current_stock: 2000, min_stock: 500, status: 'Active', mat_barcode: '8850123456819', name: 'Instant Coffee Instant Coffee 250g', unit_price: 0.76 },
      { id: 'MAT032', category: 'Sweetener', brand: 'Agave Nectar', item: 'Agave Syrup 500ml', qty: 500, unit: 'ml', price: 110, yield: 100, current_stock: 1500, min_stock: 400, status: 'Active', mat_barcode: '8850123456820', name: 'Agave Nectar Agave Syrup 500ml', unit_price: 0.22 },
      { id: 'MAT033', category: 'Spices', brand: 'Star Anise', item: 'Star Anise 50g', qty: 50, unit: 'g', price: 95, yield: 94, current_stock: 400, min_stock: 150, status: 'Active', mat_barcode: '8850123456821', name: 'Star Anise Star Anise 50g', unit_price: 2.021 },
      { id: 'MAT034', category: 'Packaging', brand: 'Napkins Plus', item: 'Napkins 500pcs', qty: 500, unit: 'pcs', price: 45, yield: 100, current_stock: 2000, min_stock: 400, status: 'Active', mat_barcode: '8850123456822', name: 'Napkins Plus Napkins 500pcs', unit_price: 0.09 },
      { id: 'MAT035', category: 'Beans', brand: 'Panama Geisha', item: 'Premium Blend 500g', qty: 500, unit: 'g', price: 550, yield: 92, current_stock: 600, min_stock: 200, status: 'Active', mat_barcode: '8850123456823', name: 'Panama Geisha Premium Blend 500g', unit_price: 1.195 }
    ];
    for (const m of materials) await insertRow('materials', m, client);

    const menus = [
      { id: 'MN001', name: 'Espresso', category: 'Coffee', front_price: 60, delivery_price: 75, status: 'Active' },
      { id: 'MN002', name: 'Latte', category: 'Coffee', front_price: 70, delivery_price: 85, status: 'Active' },
      { id: 'MN003', name: 'Iced Cocoa', category: 'Cocoa', front_price: 65, delivery_price: 80, status: 'Active' }
    ];
    for (const m of menus) await insertRow('menuname', m, client);

    await insertRow('packagingbom', {
      id: 'PBOM001', name: 'Standard 16oz Cold Cup Set',
      items: JSON.stringify([{ material_id: 'MAT005', qty_used: 1 }, { material_id: 'MAT006', qty_used: 1 }])
    }, client);

    const boms = [
      { menu_name: 'Espresso', material_id: 'MAT001', qty_used: 18 },
      { menu_name: 'Espresso', material_id: 'MAT004', qty_used: 10 },
      { menu_name: 'Espresso', material_id: 'PBOM001', qty_used: 1 },
      { menu_name: 'Latte', material_id: 'MAT001', qty_used: 18 },
      { menu_name: 'Latte', material_id: 'MAT002', qty_used: 150 },
      { menu_name: 'Latte', material_id: 'MAT004', qty_used: 10 },
      { menu_name: 'Latte', material_id: 'PBOM001', qty_used: 1 },
      { menu_name: 'Iced Cocoa', material_id: 'MAT003', qty_used: 20 },
      { menu_name: 'Iced Cocoa', material_id: 'MAT002', qty_used: 120 },
      { menu_name: 'Iced Cocoa', material_id: 'MAT004', qty_used: 25 },
      { menu_name: 'Iced Cocoa', material_id: 'PBOM001', qty_used: 1 }
    ];
    for (const b of boms) await insertRow('bom', b, client);

    const addons = [
      { name: 'Whipped Cream', price_change: 15 },
      { name: 'Caramel Drizzle', price_change: 10 },
      { name: 'Chocolate Chips', price_change: 12 }
    ];
    for (const a of addons) await insertRow('addons', a, client);

    await insertRow('promotions', {
      name: '10 Points = 1 Free Cup', type: 'points', status: 'Active',
      buy_qty: 10, free_qty: 1, max_free_value: 70
    }, client);

    const customers = [
      { name: 'John Doe', address: '123 Sukhumvit Rd, Bangkok', gender: 'M' },
      { name: 'Jane Smith', address: '456 Silom Rd, Bangkok', gender: 'F' },
      { name: 'Somsak Lee', address: '789 Sathorn Rd, Bangkok', gender: 'M' }
    ];
    for (const c of customers) await insertRow('customers', c, client);

    const salefronts = [
      { date: '2026-01-15', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', menu_name: 'Espresso', quantity: 2, sweetness: '100%', container: 'Ice', addons: JSON.stringify(['Whipped Cream']), addon_price: 15, total_price: 150, cashier: 'admin' },
      { date: '2026-02-10', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', menu_name: 'Latte', quantity: 1, sweetness: '50%', container: 'Ice', addons: JSON.stringify([]), addon_price: 0, total_price: 70, cashier: 'admin' },
      { date: '2026-03-05', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', menu_name: 'Iced Cocoa', quantity: 3, sweetness: '100%', container: 'Ice', addons: JSON.stringify([]), addon_price: 0, total_price: 195, cashier: 'staff' },
      { date: '2026-04-12', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', menu_name: 'Latte', quantity: 4, sweetness: '25%', container: 'Hot', addons: JSON.stringify([]), addon_price: 0, total_price: 280, cashier: 'admin' },
      { date: '2026-05-20', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', menu_name: 'Espresso', quantity: 10, sweetness: '0%', container: 'Bottle', addons: JSON.stringify([]), addon_price: 0, total_price: 550, cashier: 'staff' },
      { date: '2026-06-01', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', menu_name: 'Iced Cocoa', quantity: 2, sweetness: '50%', container: 'Ice', addons: JSON.stringify(['Chocolate Chips']), addon_price: 12, total_price: 154, cashier: 'admin' }
    ];
    for (const s of salefronts) await insertRow('salefront', s, client);

    const deliveries = [
      { date: '2026-01-20', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', raw_order_string: 'Espresso (3), Latte (2)', base_price: 395, discount_tier1: '10%', discount_type1: 'percentage', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 40, net_price: 315.5, status: 'Delivered', cashier: 'admin' },
      { date: '2026-02-18', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', raw_order_string: 'Iced Cocoa (4)', base_price: 320, discount_tier1: 'WELCOME', discount_type1: 'code', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 30, net_price: 250, status: 'Delivered', cashier: 'admin' },
      { date: '2026-03-22', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', raw_order_string: 'Latte (5)', base_price: 425, discount_tier1: '15', discount_type1: 'flat', discount_tier2: '5%', discount_type2: 'percentage', discount_tier3: '', discount_type3: '', ad_cost: 50, net_price: 339.5, status: 'Delivered', cashier: 'staff' },
      { date: '2026-04-28', customer_name: 'John Doe', customer_address: '123 Sukhumvit Rd, Bangkok', raw_order_string: 'Espresso (1), Iced Cocoa (2)', base_price: 235, discount_tier1: '', discount_type1: '', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 25, net_price: 210, status: 'Delivered', cashier: 'admin' },
      { date: '2026-05-15', customer_name: 'Jane Smith', customer_address: '456 Silom Rd, Bangkok', raw_order_string: 'Latte (2)', base_price: 170, discount_tier1: '10%', discount_type1: 'percentage', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 20, net_price: 133, status: 'Delivered', cashier: 'admin' },
      { date: '2026-06-05', customer_name: 'Somsak Lee', customer_address: '789 Sathorn Rd, Bangkok', raw_order_string: 'Espresso (4)', base_price: 300, discount_tier1: 'PROMO10', discount_type1: 'code', discount_tier2: '', discount_type2: '', discount_tier3: '', discount_type3: '', ad_cost: 30, net_price: 240, status: 'Pending', cashier: 'staff' }
    ];
    for (const d of deliveries) await insertRow('saledelivery', d, client);

    const expenses = [
      { date: '2026-01-02', description: 'Arabica Premium Beans 500g', amount: 1750, buyer: 'Admin', mat_barcode: '8850123456789', qty: 5, unit: 'g', price: 350, category: 'Beans', discount: 0, shipping_cost: 0, note: 'Initial stock setup' },
      { date: '2026-02-15', description: 'Meiji Milk 2L', amount: 950, buyer: 'Staff', mat_barcode: '8850123456790', qty: 10, unit: 'ml', price: 95, category: 'Dairy', discount: 0, shipping_cost: 0, note: 'Stock order' },
      { date: '2026-03-10', description: 'Rent Payment', amount: 12000, buyer: 'Admin', mat_barcode: '', qty: 1, unit: 'month', price: 12000, category: 'Rent', discount: 0, shipping_cost: 0, note: 'Monthly cafe rent' },
      { date: '2026-04-05', description: 'Mitr Phol Syrup 1L', amount: 480, buyer: 'Buyer A', mat_barcode: '8850123456792', qty: 8, unit: 'ml', price: 60, category: 'Sweetener', discount: 0, shipping_cost: 0, note: '' },
      { date: '2026-05-10', description: 'Van Houten Cocoa 500g', amount: 1120, buyer: 'Admin', mat_barcode: '8850123456791', qty: 4, unit: 'g', price: 280, category: 'Powder', discount: 0, shipping_cost: 0, note: '' },
      { date: '2026-06-02', description: 'Electric Bill', amount: 3450, buyer: 'Admin', mat_barcode: '', qty: 1, unit: 'pcs', price: 3450, category: 'Utility', discount: 0, shipping_cost: 0, note: '' }
    ];
    for (const e of expenses) await insertRow('expenses', e, client);
  });
}
