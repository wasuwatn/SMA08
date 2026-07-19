// ---- LINE receipt-OCR expense intake (Make.com automation) ----------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
// Make.com posts a slip here right after OCR; a human then reviews/edits it
// from a LIFF page before it becomes a real `expenses` row. Mounted before
// the staff guard because neither caller carries a staff JWT — Make
// authenticates with a shared secret, the LIFF page with the slip's own
// one-time `confirm_token` (no separate login for that page).
// See INTEGRATION_PLAN.md Phase 1 for the full flow.
import crypto from 'node:crypto';
import { pool, withTransaction, insertRow, getRow, adjustStock, logActivity } from '../db.js';
import { fail } from '../shared.js';

const LINE_SLIP_SECRET = process.env.LINE_SLIP_SECRET;

export function registerLineSlipsRoutes(app) {
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
  // itself (same pattern as runCheckout's redemption burn) — a re-tapped
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
}
