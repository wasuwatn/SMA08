// Table configuration + generic CRUD helpers.
import { pool } from './db.js';

/*
 * Table configuration.
 *  - pk: primary key column
 *  - auto: true => integer pk auto-assigned by Postgres (SERIAL) when omitted
 *  - columns: ordered list of all columns (used for generic CRUD)
 */
export const TABLE_CONFIG = {
  // pin: bcrypt-hashed 4-digit PIN for POS satellite-app login (POST
  // /api/auth/pin-login in index.js) — nullable, a staff member can't use
  // PIN login until an admin sets one from the Users page. Separate from
  // `password`, which stays the credential for this app and for changing
  // one's own PIN.
  users: {
    pk: 'username', auto: false,
    columns: ['username', 'password', 'role', 'access', 'pin'],
    ddl: `CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, password TEXT, role TEXT, access TEXT, pin TEXT)`
  },
  // current_theme was dropped (Phase-1 cleanup below) — theme now lives in
  // localStorage only (see chooseTheme() in Settings.jsx).
  // expense_line_users: allowlist for the in-chat LINE expense bot —
  // comma-separated "U<lineUserId>:BuyerName" entries (name optional). Only
  // these LINE users can log expenses by chatting with the OA; everyone else
  // (reward customers on the same OA) is silently ignored.
  settings: {
    pk: 'id', auto: true,
    columns: ['id', 'sweetness_levels', 'buyers', 'logo',
      'shop_name', 'shop_address', 'shop_phone', 'promptpay_id', 'receipt_footer',
      'expense_line_users'],
    ddl: `CREATE TABLE IF NOT EXISTS settings (
      id SERIAL PRIMARY KEY, sweetness_levels TEXT, buyers TEXT, logo TEXT,
      shop_name TEXT, shop_address TEXT, shop_phone TEXT, promptpay_id TEXT, receipt_footer TEXT,
      expense_line_users TEXT)`
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
    // `color` is an optional hex string (e.g. "#2d8ac9") for the POS sell
    // screen's card background; null/empty falls back to the client's
    // deterministic per-category palette.
    columns: ['id', 'name', 'category', 'front_price', 'delivery_price', 'status', 'color'],
    ddl: `CREATE TABLE IF NOT EXISTS menuname (
      id TEXT PRIMARY KEY, name TEXT, category TEXT, front_price DOUBLE PRECISION,
      delivery_price DOUBLE PRECISION, status TEXT, color TEXT)`
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
  // Links a menu (menuname.id) to an optional modifier category (an
  // addons row whose kind is 'modcat:<mode>') it should offer at POS. The
  // three mandatory categories (ภาชนะ/ความหวาน/ของเพิ่ม) are implied for
  // every menu client-side and never stored here — only opt-in links are.
  menu_modifiers: {
    pk: 'id', auto: true,
    columns: ['id', 'menu_id', 'category_id'],
    ddl: `CREATE TABLE IF NOT EXISTS menu_modifiers (
      id SERIAL PRIMARY KEY, menu_id TEXT, category_id INTEGER)`
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
  // "Pending slip" bucket shared by both expense-intake flows: the LINE x
  // Make.com OCR + LIFF review flow (see INTEGRATION_PLAN.md Phase 1) and the
  // in-chat LINE bot (server/lineExpense.js). `confirm_token` gates the LIFF
  // page's read/confirm — the token IS the auth for that one slip. The chat
  // flow instead stores its analyzed line items in `items` (JSON array of
  // {description, amount, category, selected}) and authenticates postbacks by
  // matching `line_user_id`. `line_message_id` is UNIQUE so a retried webhook
  // delivery can't create a second pending row for the same physical slip.
  // `expense_id` is filled in once the slip is confirmed into `expenses`.
  pending_slips: {
    pk: 'id', auto: true,
    columns: ['id', 'line_message_id', 'line_user_id', 'amount', 'merchant', 'category',
      'slip_image_url', 'ocr_raw', 'status', 'confirm_token', 'expense_id', 'created_at', 'confirmed_at',
      'items'],
    ddl: `CREATE TABLE IF NOT EXISTS pending_slips (
      id SERIAL PRIMARY KEY, line_message_id TEXT UNIQUE, line_user_id TEXT,
      amount DOUBLE PRECISION DEFAULT 0, merchant TEXT, category TEXT,
      slip_image_url TEXT, ocr_raw TEXT, status TEXT DEFAULT 'pending',
      confirm_token TEXT, expense_id INTEGER, created_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ,
      items TEXT)`
  }
};

export const TABLES = Object.keys(TABLE_CONFIG);

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
