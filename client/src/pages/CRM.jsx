import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money, parseOrderCups } from '../lib/helpers.js';
import Modal from '../components/Modal.jsx';

export default function CRM() {
  const { user, data, reload, pushToast } = useData();
  const { customers, saledelivery } = data;
  // Voided bills stay in the table but must not count toward spend/cups.
  const salefront = data.salefront.filter(s => s.status !== 'void');
  const [search, setSearch] = useState('');
  const [granting, setGranting] = useState(null); // { customer, points, note }
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null); // customer whose history modal is open

  const canGrant = user && (user.role === 'Admin' || String(user.access || '').split(',').includes('points'));

  // Claimed ledger rows only — pending links belong to nobody yet.
  // Balance nets earned + spent rows; earned totals only the positive (link/crm) grants.
  const { balances, earned } = useMemo(() => {
    const balMap = new Map();
    const earnedMap = new Map();
    for (const row of data.point_ledger || []) {
      if (row.status !== 'claimed' || row.customer_id == null) continue;
      const id = Number(row.customer_id);
      const pts = Number(row.points) || 0;
      balMap.set(id, (balMap.get(id) || 0) + pts);
      if (pts > 0) earnedMap.set(id, (earnedMap.get(id) || 0) + pts);
    }
    return { balances: balMap, earned: earnedMap };
  }, [data.point_ledger]);

  const rows = customers.map(c => {
    const nl = c.name.toLowerCase();
    const fs = salefront.filter(s => s.customer_id != null
      ? Number(s.customer_id) === c.id
      : s.customer_name && s.customer_name.toLowerCase() === nl);
    const ds = saledelivery.filter(s => s.customer_id != null
      ? Number(s.customer_id) === c.id
      : s.customer_name && s.customer_name.toLowerCase() === nl);
    const spending = fs.reduce((s, x) => s + (Number(x.total_price) || 0), 0) + ds.reduce((s, x) => s + (Number(x.net_price) || 0), 0);
    const frontCups = fs.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
    let deliCups = 0;
    ds.forEach(x => Object.values(parseOrderCups(x.raw_order_string)).forEach(q => deliCups += q));
    const dates = [...fs.map(s => s.date), ...ds.map(s => s.date)].filter(Boolean).sort().reverse();
    return {
      id: c.id, name: c.name, address: c.address || 'N/A',
      orders: fs.length + ds.length, spending, cups: frontCups + deliCups,
      last: dates[0] || 'N/A', points: balances.get(c.id) || 0,
      pointsEarned: earned.get(c.id) || 0, customer: c
    };
  }).filter(r => r.spending > 0 || r.points !== 0).sort((a, b) => b.spending - a.spending);

  const totalSpending = rows.reduce((s, r) => s + r.spending, 0);
  const totalCups = salefront.reduce((s, x) => s + (Number(x.quantity) || 0), 0)
    + saledelivery.reduce((s, x) => s + Object.values(parseOrderCups(x.raw_order_string)).reduce((a, b) => a + b, 0), 0);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => [r.name, r.address].some(v => String(v || '').toLowerCase().includes(q)));
  }, [rows, search]);

  // One combined, date-sorted feed of everything that happened to this
  // customer: orders (front rows grouped by order_no, one row per delivery
  // order) and claimed point-ledger events (grants/links earned, spend redeemed).
  const viewingHistory = useMemo(() => {
    if (!viewing) return [];
    const nl = viewing.name.toLowerCase();
    const matches = (s) => s.customer_id != null
      ? Number(s.customer_id) === viewing.id
      : s.customer_name && s.customer_name.toLowerCase() === nl;
    const fs = salefront.filter(matches);
    const ds = saledelivery.filter(matches);

    const frontOrders = new Map();
    fs.forEach(row => {
      const key = row.order_no || `legacy-${row.id}`;
      let order = frontOrders.get(key);
      if (!order) {
        order = { type: 'order', date: row.date, channel: 'POS', total: 0, items: [] };
        frontOrders.set(key, order);
      }
      order.total += Number(row.total_price) || 0;
      order.items.push(`${row.menu_name}${row.variant ? ` (${row.variant})` : ''} x${row.quantity}`);
    });

    const events = [
      ...frontOrders.values(),
      ...ds.map(row => ({
        type: 'order', date: row.date, channel: 'Delivery',
        total: Number(row.net_price) || 0,
        items: (row.raw_order_string || '').split(',').map(s => s.trim()).filter(Boolean)
      })),
      ...(data.point_ledger || [])
        .filter(row => row.status === 'claimed' && row.customer_id != null && Number(row.customer_id) === viewing.id)
        .map(row => ({
          type: 'points', date: (row.claimed_at || row.created_at || '').slice(0, 10),
          points: Number(row.points) || 0, note: row.note, kind: row.kind
        }))
    ];

    return events.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }, [viewing, salefront, saledelivery, data.point_ledger]);

  const doGrant = async () => {
    const pts = Number(granting.points);
    if (!Number.isInteger(pts) || pts <= 0) return pushToast('Points must be a positive whole number.', 'warning');
    setBusy(true);
    try {
      const r = await api.pointsGrant({ customer_id: granting.customer.id, points: pts, note: granting.note.trim() || undefined });
      await reload(['point_ledger']);
      setGranting(null);
      pushToast(`Granted ${pts} point${pts > 1 ? 's' : ''} to ${granting.customer.name} (balance ${r.balance}).`, 'success');
    } catch (e) {
      pushToast(e.message || 'Could not grant points.', 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid-3">
        <div className="stat-pill"><div className="label">Total Customers</div><div className="value">{customers.length}</div></div>
        <div className="stat-pill"><div className="label">Total Spending</div><div className="value">{money(totalSpending)}</div></div>
        <div className="stat-pill"><div className="label">Total Cups Sold</div><div className="value">{totalCups}</div></div>
      </div>
      <div className="card">
        <div className="card-header"><h3>Customer Analytics (by spending)</h3>
          <input className="form-control" style={{ maxWidth: 220 }} placeholder="Search customers..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Rank</th><th>Name</th><th>Address</th><th>Orders</th><th>Spending</th><th>Total Points</th><th>Remaining Points</th><th>Last Order</th>{canGrant && <th></th>}</tr></thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((r, i) => (
                <tr key={r.id}>
                  <td><strong>#{i + 1}</strong></td>
                  <td>
                    <button onClick={() => setViewing(r.customer)}
                      style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--primary)', textDecoration: 'underline' }}>
                      <strong>{r.name}</strong>
                    </button>
                  </td>
                  <td><span className="helper-text">{r.address}</span></td>
                  <td>{r.orders}</td><td><strong>{money(r.spending)}</strong></td>
                  <td>
                    {r.pointsEarned > 0
                      ? <strong>⭐ {r.pointsEarned}</strong>
                      : <span className="helper-text">{r.pointsEarned}</span>}
                  </td>
                  <td>
                    {r.points > 0
                      ? <strong style={{ color: 'var(--success-color)' }}>⭐ {r.points}</strong>
                      : <span className="helper-text">{r.points}</span>}
                  </td>
                  <td><span className="badge local">{r.last}</span></td>
                  {canGrant && (
                    <td>
                      <button className="btn btn-sm btn-secondary" title="Grant points"
                        onClick={() => setGranting({ customer: r.customer, points: 1, note: '' })}>
                        <i className="fa-solid fa-coins"></i>
                      </button>
                    </td>
                  )}
                </tr>
              )) : <tr className="empty-row"><td colSpan={canGrant ? 9 : 8}>No customer records found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {granting && (
        <Modal title={`Grant points — ${granting.customer.name}`} onClose={() => setGranting(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setGranting(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={doGrant}>Grant</button>
          </>}>
          <div className="field"><label>Points</label>
            <input type="number" min="1" step="1" className="form-control" autoFocus value={granting.points}
              onChange={(e) => setGranting(g => ({ ...g, points: e.target.value }))} />
          </div>
          <div className="field"><label>Note (optional)</label>
            <input className="form-control" value={granting.note} placeholder="e.g. compensation, birthday"
              onChange={(e) => setGranting(g => ({ ...g, note: e.target.value }))} />
          </div>
          <p className="helper-text">Points are added immediately — no link for the customer to click.</p>
        </Modal>
      )}

      {viewing && (
        <Modal title={`History — ${viewing.name}`} onClose={() => setViewing(null)} maxWidth={640}>
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table className="data">
              <thead><tr><th>Date</th><th>Type</th><th>Detail</th><th>Amount</th></tr></thead>
              <tbody>
                {viewingHistory.length ? viewingHistory.map((h, i) => (
                  <tr key={i}>
                    <td>{h.date || 'N/A'}</td>
                    <td>
                      {h.type === 'points'
                        ? <span className={`badge ${h.points > 0 ? 'bg-green' : 'local'}`}>{h.points > 0 ? 'Points' : 'Redeemed'}</span>
                        : <span className="badge local">{h.channel}</span>}
                    </td>
                    <td>
                      {h.type === 'points' ? (
                        <span className="helper-text">
                          {h.note || (h.kind === 'spend' ? 'Redeemed for free cup' : 'Points received')}
                        </span>
                      ) : h.items.length ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {h.items.map((it, j) => <span key={j} className="helper-text">{it}</span>)}
                        </div>
                      ) : <span className="helper-text">—</span>}
                    </td>
                    <td>
                      {h.type === 'points'
                        ? <strong style={{ color: h.points > 0 ? 'var(--success-color)' : undefined }}>{h.points > 0 ? '+' : ''}{h.points}</strong>
                        : <strong>{money(h.total)}</strong>}
                    </td>
                  </tr>
                )) : <tr className="empty-row"><td colSpan={4}>No history yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
