// ---- Register shifts (open / close with Z-report) -------------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
// One shift may be open at a time. POS stamps each sale row with the open
// shift's id, so closing aggregates exactly the rows rung during the shift.
import { pool, withTransaction, insertRow, updateRow, logActivity } from '../db.js';
import { fail, actor, canWrite, forbidden } from '../shared.js';

const SHIFT_LOCK_KEY = 823401; // arbitrary advisory-lock key for open/close races

export function registerShiftRoutes(app) {
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
}
