// ---- Shop-issued point links & grants, void, redemption --------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
// Links are minted here (Points page / CRM), claimed by the customer in the
// LINE portal via POST /api/customer/claim-points. The client builds the
// share URL from the token — the server doesn't need to know the portal origin.
import crypto from 'node:crypto';
import { pool, withTransaction, insertRow, getRow, updateRow, logActivity } from '../db.js';
import {
  fail, actor, isAdmin, canWrite, forbidden,
  activePointsPromotion, pointsBalanceFor, redemptionAvailability, POINTS_LOCK_KEY
} from '../shared.js';

export function registerPointsRoutes(app) {
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
}
