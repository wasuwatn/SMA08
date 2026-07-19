// ---- Delivery report import (Wongnai) ------------------------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
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
import { withTransaction, insertRow, adjustStock, logActivity } from '../db.js';
import { fail, actor, canWrite, forbidden } from '../shared.js';

const DELIVERY_GP_RATE = 0.321;

export function registerDeliveryRoutes(app) {
  app.post('/api/import/delivery', async (req, res) => {
    if (!canWrite(req, 'deliverydaily')) return forbidden(res);
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
            const adj = await adjustStock(r.material_id, -r.qty, { client });
            if (!adj.ok) continue;
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
      fail(res, e);
    }
  });
}
