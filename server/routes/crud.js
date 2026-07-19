// ---- Generic CRUD (registered last so specific routes take priority) -----
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
// GET supports optional windowing on tables that have a `date` column
// (?since=YYYY-MM-DD&until=YYYY-MM-DD) plus ?limit=N (newest first) so clients
// don't have to pull a whole table once history grows.
import { pool, TABLE_CONFIG, insertRow, updateRow, deleteRow, getRow, hashPassword, logActivity } from '../db.js';
import { fail, actor, isAdmin, canWrite, forbidden, valid, PIN_RE } from '../shared.js';

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

export function registerCrudRoutes(app) {
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
}
