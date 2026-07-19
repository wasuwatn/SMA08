// ---- Backup / restore (Admin only) ---------------------------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
import { withTransaction, insertRow, listRows, TABLES, logActivity } from '../db.js';
import { fail, actor, isAdmin } from '../shared.js';

export function registerAdminOpsRoutes(app) {
  app.get('/api/backup', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
    try {
      const out = {};
      for (const t of TABLES) out[t] = await listRows(t);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/restore', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
    const payload = req.body || {};
    try {
      await withTransaction(async (client) => {
        for (const t of TABLES) {
          if (Array.isArray(payload[t])) {
            await client.query(`DELETE FROM ${t}`);
            for (const row of payload[t]) await insertRow(t, row, client);
          }
        }
      });
      await logActivity(actor(req), 'RESTORE', 'JSON backup restored');
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });
}
