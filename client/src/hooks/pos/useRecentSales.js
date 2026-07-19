import { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/api.js';

// How far back POS keeps its own local Sales History / shift-cash lookback.
// POS doesn't load the full salefront table (see skipHeavyTables in
// data.jsx) — a shift never runs longer than this, so it's plenty for both
// the history overlay and the close-shift cash estimate.
const HISTORY_WINDOW_DAYS = 14;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };

// Recent sales (last HISTORY_WINDOW_DAYS) fetched on demand — POS keeps its
// own small window instead of the shared data.salefront cache, which the
// satellite apps skip loading (see skipHeavyTables in data.jsx).
export function useRecentSales() {
  const [recentSales, setRecentSales] = useState([]);
  const refreshRecentSales = useCallback(() => {
    api.list('salefront', { since: daysAgo(HISTORY_WINDOW_DAYS) })
      .then(rows => setRecentSales(rows.filter(r => r.status !== 'void')))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshRecentSales(); }, [refreshRecentSales]);
  return { recentSales, refreshRecentSales };
}
