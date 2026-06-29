import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { money, parseOrderCups, loyaltyStatus } from '../lib/helpers.js';

export default function CRM() {
  const { data } = useData();
  const { customers, salefront, saledelivery } = data;
  const [search, setSearch] = useState('');

  const promotion = (data.promotions || []).find(p => p.type === 'stamp' && p.status === 'Active');

  const rows = customers.map(c => {
    const nl = c.name.toLowerCase();
    const fs = salefront.filter(s => s.customer_name && s.customer_name.toLowerCase() === nl);
    const ds = saledelivery.filter(s => s.customer_name && s.customer_name.toLowerCase() === nl);
    const spending = fs.reduce((s, x) => s + (Number(x.total_price) || 0), 0) + ds.reduce((s, x) => s + (Number(x.net_price) || 0), 0);
    const frontCups = fs.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
    let deliCups = 0;
    ds.forEach(x => Object.values(parseOrderCups(x.raw_order_string)).forEach(q => deliCups += q));
    const dates = [...fs.map(s => s.date), ...ds.map(s => s.date)].filter(Boolean).sort().reverse();
    const loyalty = loyaltyStatus(c.name, salefront, promotion);
    return {
      id: c.id, name: c.name, address: c.address || 'N/A',
      orders: fs.length + ds.length, spending, cups: frontCups + deliCups,
      last: dates[0] || 'N/A', loyalty
    };
  }).filter(r => r.spending > 0).sort((a, b) => b.spending - a.spending);

  const totalSpending = rows.reduce((s, r) => s + r.spending, 0);
  const totalCups = salefront.reduce((s, x) => s + (Number(x.quantity) || 0), 0)
    + saledelivery.reduce((s, x) => s + Object.values(parseOrderCups(x.raw_order_string)).reduce((a, b) => a + b, 0), 0);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => [r.name, r.address].some(v => String(v || '').toLowerCase().includes(q)));
  }, [rows, search]);

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
            <thead><tr><th>Rank</th><th>Name</th><th>Address</th><th>Orders</th><th>Spending</th><th>Loyalty</th><th>Last Order</th></tr></thead>
            <tbody>
              {filteredRows.length ? filteredRows.map((r, i) => (
                <tr key={r.id}>
                  <td><strong>#{i + 1}</strong></td><td><strong>{r.name}</strong></td>
                  <td><span className="helper-text">{r.address}</span></td>
                  <td>{r.orders}</td><td><strong>{money(r.spending)}</strong></td>
                  <td>
                    {promotion ? (
                      <span className="helper-text">
                        🎫 {r.loyalty.purchased % Number(promotion.buy_qty)}/{promotion.buy_qty}
                        {r.loyalty.available > 0 && <strong style={{ color: 'var(--success-color)', marginLeft: 4 }}>🎁 {r.loyalty.available}</strong>}
                      </span>
                    ) : <span className="helper-text">—</span>}
                  </td>
                  <td><span className="badge local">{r.last}</span></td>
                </tr>
              )) : <tr className="empty-row"><td colSpan={7}>No customer records found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
