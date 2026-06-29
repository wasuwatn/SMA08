import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { money } from '../lib/helpers.js';
import Modal from '../components/Modal.jsx';

// Only `stamp` (buy N cups, get M free) is implemented today — the type
// dropdown is fixed but kept as a real field so more types (percent
// discount, buy-X-get-Y, menu special) can be added later without a
// schema change (see promotions.config in server/db.js).
const PROMO_TYPES = [{ value: 'stamp', label: 'Stamp card (buy N, get M free)' }];
const blank = { name: '', type: 'stamp', status: 'Active', buy_qty: 10, free_qty: 1, max_free_value: 70 };

export default function Promotions() {
  const { data, insert, update, remove, pushToast } = useData();
  const list = useMemo(() => [...data.promotions].sort((a, b) => b.id - a.id), [data.promotions]);
  const [editing, setEditing] = useState(null);

  const save = async () => {
    if (!editing.name.trim()) return pushToast('Promotion name is required.', 'warning');
    const payload = {
      name: editing.name.trim(),
      type: editing.type || 'stamp',
      status: editing.status || 'Active',
      buy_qty: Number(editing.buy_qty) || 1,
      free_qty: Number(editing.free_qty) || 1,
      max_free_value: Number(editing.max_free_value) || 0
    };
    if (editing.id) { await update('promotions', editing.id, payload); pushToast('Promotion updated.', 'success'); }
    else { await insert('promotions', payload); pushToast('Promotion added.', 'success'); }
    setEditing(null);
  };

  const del = async (id) => {
    if (confirm('Delete this promotion?')) { await remove('promotions', id); pushToast('Promotion removed.', 'success'); }
  };

  const toggleStatus = async (p) => {
    await update('promotions', p.id, { status: p.status === 'Active' ? 'Inactive' : 'Active' });
  };

  return (
    <div className="card">
      <div className="card-header"><h3>Promotions</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing({ ...blank })}>
          <i className="fa-solid fa-plus"></i> Add Promotion
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th>Name</th><th>Type</th><th>Buy</th><th>Free</th><th>Max free value</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>
            {list.length ? list.map(p => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong></td>
                <td><span className="helper-text">{PROMO_TYPES.find(t => t.value === p.type)?.label || p.type}</span></td>
                <td>{p.buy_qty}</td>
                <td>{p.free_qty}</td>
                <td>{money(p.max_free_value)}</td>
                <td>
                  <button className={`badge ${p.status === 'Active' ? 'local' : ''}`} onClick={() => toggleStatus(p)}>
                    {p.status}
                  </button>
                </td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => setEditing(p)}><i className="fa-solid fa-pen-to-square"></i></button>
                  <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => del(p.id)}><i className="fa-solid fa-trash-can"></i></button>
                </td>
              </tr>
            )) : <tr className="empty-row"><td colSpan={7}>No promotions yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={editing.id ? 'Edit Promotion' : 'Add Promotion'} onClose={() => setEditing(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="field"><label>Name</label>
            <input className="form-control" value={editing.name} autoFocus onChange={(e) => setEditing(p => ({ ...p, name: e.target.value }))} />
          </div>
          <div className="field"><label>Type</label>
            <select className="form-control" value={editing.type} onChange={(e) => setEditing(p => ({ ...p, type: e.target.value }))}>
              {PROMO_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Buy quantity (cups)</label>
            <input type="number" min="1" className="form-control" value={editing.buy_qty} onChange={(e) => setEditing(p => ({ ...p, buy_qty: e.target.value }))} />
          </div>
          <div className="field"><label>Free quantity (cups)</label>
            <input type="number" min="1" className="form-control" value={editing.free_qty} onChange={(e) => setEditing(p => ({ ...p, free_qty: e.target.value }))} />
          </div>
          <div className="field"><label>Max free cup value (฿)</label>
            <input type="number" min="0" className="form-control" value={editing.max_free_value} onChange={(e) => setEditing(p => ({ ...p, max_free_value: e.target.value }))} />
          </div>
          <div className="field"><label>Status</label>
            <select className="form-control" value={editing.status} onChange={(e) => setEditing(p => ({ ...p, status: e.target.value }))}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>
        </Modal>
      )}
    </div>
  );
}
