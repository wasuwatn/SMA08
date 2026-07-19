// ---- Checkout (transactional stock deduction) + Expense --------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
// body: { sales:[{...}], requirements:[{material_id, qty, note}], date }
// One row per cup is inserted; stock requirements are aggregated for the order.
// `force` (set only when flushing an offline-queued sale) skips the stock guard
// and allows stock to go negative: the sale already happened on the device, so
// we record it rather than reject it. Online sales leave force unset.
import crypto from 'node:crypto';
import { withTransaction, insertRow, updateRow, claimTxn, adjustStock, logActivity } from '../db.js';
import { fail, actor, canWrite, forbidden, activePointsPromotion, pointsBalanceFor, POINTS_LOCK_KEY } from '../shared.js';

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

export function registerCheckoutRoutes(app) {
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
}
