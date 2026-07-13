import React, { useMemo, useState } from 'react';
import { useData } from '../lib/data.jsx';
import { money, today, parseOrderCups, PAGE_SIZE } from '../lib/helpers.js';
import Pagination from '../components/Pagination.jsx';

export default function DailyCups() {
  const { data } = useData();
  const [day, setDay] = useState(today());
  const [page, setPage] = useState(1);

  // One card per transaction record on the selected day (POS cup rows + delivery orders).
  const cards = useMemo(() => {
    const pos = data.salefront.filter(s => s.status !== 'void' && s.date === day).map(s => {
      let addons = []; try { addons = JSON.parse(s.addons || '[]'); } catch { /* */ }
      return {
        key: `f${s.id}`, channel: 'POS', icon: 'fa-cash-register',
        title: s.menu_name + (s.variant ? ` · ${s.variant}` : ''),
        cups: Number(s.quantity) || 0,
        detail: `${s.container} / Sugar ${s.sweetness}${addons.length ? ` · ${addons.join(', ')}` : ''}`,
        customer: s.customer_name, address: s.customer_address, total: s.total_price
      };
    });
    const deli = data.saledelivery.filter(s => s.date === day).map(s => {
      const cups = Object.values(parseOrderCups(s.raw_order_string)).reduce((a, b) => a + b, 0);
      return {
        key: `d${s.id}`, channel: 'Delivery', icon: 'fa-motorcycle',
        title: s.raw_order_string, cups, detail: 'Delivery order',
        customer: s.customer_name, address: s.customer_address, total: s.net_price
      };
    });
    return [...pos, ...deli];
  }, [data.salefront, data.saledelivery, day]);

  const totalCups = cards.reduce((s, c) => s + c.cups, 0);
  const total = cards.length;
  const pageRows = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <div className="card mb-12">
        <div className="flex-between">
          <div className="field" style={{ margin: 0 }}>
            <label>Filter by day</label>
            <input type="date" className="form-control" value={day} onChange={(e) => { setDay(e.target.value); setPage(1); }} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="helper-text">Total for {day}</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'Outfit', color: 'var(--primary)' }}>{totalCups} cups · {total} orders</div>
          </div>
        </div>
      </div>

      {pageRows.length ? (
        <div className="daily-card-grid">
          {pageRows.map(c => (
            <div className="daily-card" key={c.key}>
              <div className="flex-between">
                <span className={`badge ${c.channel === 'POS' ? 'online' : 'local'}`}><i className={`fa-solid ${c.icon}`}></i> {c.channel}</span>
                <strong>{c.cups} cup{c.cups !== 1 ? 's' : ''}</strong>
              </div>
              <div className="big" style={{ fontSize: 18, margin: '8px 0 4px' }}>{c.title}</div>
              <div className="helper-text mb-12">{c.detail}</div>
              <div className="daily-card-footer">
                <div className="line"><span>Total</span><strong>{money(c.total)}</strong></div>
                <div className="line"><span><i className="fa-solid fa-user"></i> {c.customer || 'Walk-in'}</span><span><i className="fa-solid fa-location-dot"></i> {c.address || 'N/A'}</span></div>
              </div>
            </div>
          ))}
        </div>
      ) : <div className="card"><p className="helper-text">No transactions recorded on {day}.</p></div>}
      <Pagination page={page} total={total} onPage={setPage} />
    </div>
  );
}
