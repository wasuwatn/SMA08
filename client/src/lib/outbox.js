// Offline write queue for POS sales and expenses.
// ponytail: localStorage holds tens-of-sales/day fine. If a queue ever needs to
//           survive thousands of offline writes, swap the store for IndexedDB —
//           the enqueue/flush interface here stays the same.
import { api } from './api.js';

const KEY = 'KOTEA_OUTBOX';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const write = (q) => localStorage.setItem(KEY, JSON.stringify(q));

export const pendingCount = () => read().length;

// kind: 'pos' | 'expense'. payload already carries a stable client_txn_id, so a
// retried flush is idempotent on the server.
export function enqueue(kind, payload) {
  write([...read(), { kind, payload }]);
}

const send = (item) => item.kind === 'pos'
  ? api.checkoutPos({ ...item.payload, force: true }) // force: sale already happened offline
  : api.expense(item.payload);

// Try to drain the queue. Stops at the first network/server failure and keeps
// the rest for next time; drops items the server rejects as bad input (4xx,
// except 409) so one poison message can't block the queue forever.
export async function flush() {
  const q = read();
  let i = 0;
  for (; i < q.length; i++) {
    try { await send(q[i]); }
    catch (e) {
      const bad = e.status >= 400 && e.status < 500 && e.status !== 409;
      if (!bad) break; // offline / server error → retry later
    }
  }
  write(q.slice(i));
  if (i > 0) {
    // Broadcast to other tabs that data was synced
    localStorage.setItem('KOTEA_SYNC_TRIGGER', String(Date.now()));
  }
  return i;
}
