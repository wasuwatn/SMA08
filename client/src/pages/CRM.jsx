import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money, parseOrderCups } from '../lib/helpers.js';
import Modal from '../components/Modal.jsx';

export default function CRM() {
  const { user, data, reload, pushToast } = useData();
  const { customers, salefront, saledelivery } = data;
  const [search, setSearch] = useState('');
  const [granting, setGranting] = useState(null); // { customer, points, note }
  const [busy, setBusy] = useState(false);

  const canGrant = user && (user.role === 'Admin' || String(user.access || '').split(',').includes('points'));

  // Claimed ledger rows only — pending links belong to nobody yet.
  const balances = useMemo(() => {
    const map = new Map();
    for (const row of data.point_ledger || []) {
      if (row.status !== 'claimed' || row.customer_id == null) continue;
      const id = Number(row.customer_id);
      map.set(id, (map.get(id) || 0) + (Number(row.points) || 0));
    }
    return map;
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
      last: dates[0] || 'N/A', points: balances.get(c.id) || 0, customer: c
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
            <thead><tr><th>Rank</th><th>Name</th><th>Address</th><th>Orders</th><th>Spending</th><th>Points</th><th>Last Order</th>{canGrant && <th></th>}</tr></thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((r, i) => (
                <tr key={r.id}>
                  <td><strong>#{i + 1}</strong></td><td><strong>{r.name}</strong></td>
                  <td><span className="helper-text">{r.address}</span></td>
                  <td>{r.orders}</td><td><strong>{money(r.spending)}</strong></td>
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
              )) : <tr className="empty-row"><td colSpan={canGrant ? 8 : 7}>No customer records found.</td></tr>}
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
    </div>
  );
}
