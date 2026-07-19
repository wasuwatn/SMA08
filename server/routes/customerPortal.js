// ---- Customer (LINE LIFF) portal -------------------------------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
// These routes are mounted BEFORE the staff guard and carry their own auth.
// Customer tokens are signed with the same secret but tagged `kind`, and the
// staff guard explicitly rejects them so a customer can't reach /api/:table.
import jwt from 'jsonwebtoken';
import { pool, withTransaction, insertRow, updateRow, getRow, logActivity } from '../db.js';
import { JWT_SECRET, fail, activePointsPromotion, pointsBalanceFor, redemptionAvailability } from '../shared.js';

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

const GENDER_VALUES = ['M', 'F', 'NA'];

export function registerCustomerPortalRoutes(app) {
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
}
