import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money } from '../lib/helpers.js';
import Modal from '../components/Modal.jsx';
import { useTable } from '../lib/useTable.js';

const channelLabel = (r) => {
  if (r._table === 'saledelivery') return 'Delivery Import';
  const parts = ['POS'];
  if (r.order_type) parts.push(r.order_type);
  if (r.delivery_platform) parts.push(r.delivery_platform);
  return parts.join(' · ');
};

export default function SalesLog() {
  const { data, remove, reload, pushToast } = useData();

  const [search, setSearch] = useState('');

  const log = useMemo(() => {
    const front = data.salefront.map(r => ({ ...r, _table: 'salefront' }));
    const delivery = data.saledelivery.map(r => ({ ...r, _table: 'saledelivery' }));
    return [...front, ...delivery].sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return b.id - a.id;
    });
  }, [data.salefront, data.saledelivery]);

  const filteredLog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return log;
    return log.filter(r => [
      r.order_no, r.customer_name, r.date, r.menu_name, r.raw_order_string, r.order_type, r.delivery_platform
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }, [log, search]);

  const { pageRows, page, setPage, total, totalPages, from, to } = useTable(filteredLog, { pageSize: 10 });

  const [editRow, setEditRow] = useState(null);

  const saveEdit = async () => {
    if (editRow._table === 'saledelivery') {
      await api.update('saledelivery', editRow.id, {
        date: editRow.date, customer_name: editRow.customer_name,
        customer_address: editRow.customer_address || '',
        raw_order_string: editRow.raw_order_string,
        net_price: Number(editRow.net_price) || 0,
        status: editRow.status || 'Pending',
      });
      await reload('saledelivery');
    } else {
      await api.update('salefront', editRow.id, {
        date: editRow.date, customer_name: editRow.customer_name,
        customer_address: editRow.customer_address || '',
        menu_name: editRow.menu_name, variant: editRow.variant || '',
        quantity: Number(editRow.quantity) || 1,
        sweetness: editRow.sweetness || '', container: editRow.container || '',
        total_price: Number(editRow.total_price) || 0,
        order_type: editRow.order_type || '',
        delivery_platform: editRow.order_type === 'Delivery' ? (editRow.delivery_platform || '') : '',
      });
      await reload('salefront');
    }
    pushToast('Sale updated.', 'success');
    setEditRow(null);
  };

  const del = async (r) => {
    if (confirm('Delete this sale row?')) {
      await remove(r._table, r.id);
      pushToast('Sale deleted.', 'success');
    }
  };

  return (
    <>
      <div className="page-wrap">
        <div className="log-card">
          <div className="log-head">
            <h3>Transaction Log</h3>
            <div className="search-wrap">
              <i className="fa-solid fa-magnifying-glass ico"></i>
              <input className="finput" placeholder="Search orders..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            </div>
          </div>
          <div className="log-body">
            <table className="ltbl">
              <thead>
                <tr>
                  <th>Date</th><th>Order #</th><th>Customer</th><th>Order</th><th>Channel</th><th className="num">Qty</th><th className="num">Total</th><th>Cashier</th><th></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.length ? pageRows.map(r => (
                  <tr key={`${r._table}-${r.id}`} style={r.status === 'void' ? { opacity: 0.5 } : undefined}>
                    <td>{r.date}</td>
                    <td>
                      {r._table === 'saledelivery'
                        ? `DLV-${String(r.id).padStart(4, '0')}`
                        : `#${r.order_no || String(r.id).padStart(4, '0')}`}
                      {r.status === 'void' && (
                        <span className="helper-text" style={{ marginLeft: 6, color: 'var(--danger, #c0392b)', fontWeight: 700 }}>VOID</span>
                      )}
                    </td>
                    <td><strong>{r.customer_name}</strong></td>
                    <td>
                      {r._table === 'saledelivery'
                        ? r.raw_order_string
                        : `${r.menu_name}${r.variant ? ` · ${r.variant}` : ''}`}
                    </td>
                    <td><span className="helper-text">{channelLabel(r)}</span></td>
                    <td className="num">{r._table === 'saledelivery' ? 1 : r.quantity}</td>
                    <td className="num"><strong>{money(r._table === 'saledelivery' ? r.net_price : r.total_price)}</strong></td>
                    <td>{r.cashier}</td>
                    <td>
                      <button className="btn btn-sm btn-secondary" style={{ marginRight: 4 }} onClick={() => setEditRow({ ...r })}><i className="fa-solid fa-pen-to-square"></i></button>
                      <button className="btn btn-sm btn-danger" onClick={() => del(r)}><i className="fa-solid fa-xmark"></i></button>
                    </td>
                  </tr>
                )) : <tr className="empty-row"><td colSpan={9}>No sales yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="log-foot">
            <span className="pg-info">Showing {from}-{to} of {total}</span>
            <div className="pg-btns">
              <button className="btn btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}><i className="fa-solid fa-chevron-left"></i></button>
              <span className="page-num">Page {page} / {totalPages}</span>
              <button className="btn btn-sm" disabled={page === totalPages} onClick={() => setPage(page + 1)}><i className="fa-solid fa-chevron-right"></i></button>
            </div>
          </div>
        </div>
      </div>

      {editRow && editRow._table === 'saledelivery' && (
        <Modal title="Edit Delivery Order" onClose={() => setEditRow(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setEditRow(null)}>Cancel</button><button className="btn btn-primary" onClick={saveEdit}>Save</button></>}>
          <div className="frow2">
            <div className="ffield"><label className="flabel">Date</label>
              <input type="date" className="finput" value={editRow.date} onChange={(e) => setEditRow(r => ({ ...r, date: e.target.value }))} />
            </div>
            <div className="ffield"><label className="flabel">Status</label>
              <select className="finput" value={editRow.status || 'Pending'} onChange={(e) => setEditRow(r => ({ ...r, status: e.target.value }))}>
                <option>Pending</option><option>Completed</option><option>Cancelled</option>
              </select>
            </div>
          </div>
          <div className="ffield"><label className="flabel">Customer</label>
            <input className="finput" value={editRow.customer_name || ''} onChange={(e) => setEditRow(r => ({ ...r, customer_name: e.target.value }))} />
          </div>
          <div className="ffield"><label className="flabel">Address</label>
            <input className="finput" value={editRow.customer_address || ''} onChange={(e) => setEditRow(r => ({ ...r, customer_address: e.target.value }))} />
          </div>
          <div className="ffield"><label className="flabel">Order</label>
            <input className="finput" value={editRow.raw_order_string || ''} onChange={(e) => setEditRow(r => ({ ...r, raw_order_string: e.target.value }))} />
          </div>
          <div className="ffield"><label className="flabel">Net Price ฿</label>
            <input type="number" className="finput" value={editRow.net_price} onChange={(e) => setEditRow(r => ({ ...r, net_price: e.target.value }))} />
          </div>
        </Modal>
      )}

      {editRow && editRow._table === 'salefront' && (
        <Modal title="Edit Sale" onClose={() => setEditRow(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setEditRow(null)}>Cancel</button><button className="btn btn-primary" onClick={saveEdit}>Save</button></>}>
          <div className="frow2">
            <div className="ffield"><label className="flabel">Date</label>
              <input type="date" className="finput" value={editRow.date} onChange={(e) => setEditRow(r => ({ ...r, date: e.target.value }))} />
            </div>
            <div className="ffield"><label className="flabel">Qty</label>
              <input type="number" min={1} className="finput" value={editRow.quantity} onChange={(e) => setEditRow(r => ({ ...r, quantity: e.target.value }))} />
            </div>
          </div>
          <div className="ffield"><label className="flabel">Customer</label>
            <input className="finput" value={editRow.customer_name || ''} onChange={(e) => setEditRow(r => ({ ...r, customer_name: e.target.value }))} />
          </div>
          <div className="ffield"><label className="flabel">Address</label>
            <input className="finput" value={editRow.customer_address || ''} onChange={(e) => setEditRow(r => ({ ...r, customer_address: e.target.value }))} />
          </div>
          <div className="ffield"><label className="flabel">Menu</label>
            <input className="finput" value={editRow.menu_name || ''} onChange={(e) => setEditRow(r => ({ ...r, menu_name: e.target.value }))} />
          </div>
          <div className="frow2">
            <div className="ffield"><label className="flabel">Sweetness</label>
              <input className="finput" value={editRow.sweetness || ''} onChange={(e) => setEditRow(r => ({ ...r, sweetness: e.target.value }))} />
            </div>
            <div className="ffield"><label className="flabel">Container</label>
              <input className="finput" value={editRow.container || ''} onChange={(e) => setEditRow(r => ({ ...r, container: e.target.value }))} />
            </div>
          </div>
          <div className="frow2">
            <div className="ffield"><label className="flabel">Order Type</label>
              <select className="finput" value={editRow.order_type || ''} onChange={(e) => setEditRow(r => ({ ...r, order_type: e.target.value }))}>
                <option value="">—</option>
                <option>Dine-in</option><option>Takeaway</option><option>Delivery</option>
              </select>
            </div>
            <div className="ffield"><label className="flabel">Delivery Platform</label>
              <select className="finput" disabled={editRow.order_type !== 'Delivery'} value={editRow.delivery_platform || ''} onChange={(e) => setEditRow(r => ({ ...r, delivery_platform: e.target.value }))}>
                <option value="">—</option>
                <option>Lineman</option><option>Grab</option>
              </select>
            </div>
          </div>
          <div className="ffield"><label className="flabel">Total Price ฿</label>
            <input type="number" className="finput" value={editRow.total_price} onChange={(e) => setEditRow(r => ({ ...r, total_price: e.target.value }))} />
          </div>
        </Modal>
      )}
    </>
  );
}
