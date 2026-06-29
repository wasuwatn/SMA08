import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { money, nextSeqId } from '../lib/helpers.js';
import { useTable } from '../lib/useTable.js';
import Pagination from '../components/Pagination.jsx';
import Modal from '../components/Modal.jsx';

const blank = {
  id: '', category: '', brand: '', item: '', qty: 0, unit: 'g', price: 0, yield: 100,
  current_stock: 0, min_stock: 0, status: 'Active', mat_barcode: '', name: ''
};

export default function Materials() {
  const { data, insert, update, pushToast } = useData();
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.materials;
    if (q) list = list.filter(m =>
      [m.id, m.category, m.brand, m.item, m.name, m.mat_barcode].some(v => String(v || '').toLowerCase().includes(q))
    );
    return [...list].sort((a, b) => (a.status === 'Inactive') - (b.status === 'Inactive'));
  }, [data.materials, search]);
  const { pageRows, page, setPage, total, toggleSort, sortIcon } = useTable(filtered);
  const [editing, setEditing] = useState(null); // null | {...material, _isNew}

  const openNew = () => setEditing({ ...blank, id: nextSeqId('MAT', data.materials), _isNew: true });
  const openEdit = (m) => setEditing({ ...m, _isNew: false });

  const save = async () => {
    const m = editing;
    if (!m.id.trim()) return pushToast('Material ID is required.', 'warning');
    const qty = Number(m.qty) || 0, yld = Number(m.yield) || 100, price = Number(m.price) || 0;
    const unit_price = qty > 0 && yld > 0 ? price / (qty * (yld / 100)) : 0;
    const payload = {
      ...m, qty, yield: yld, price, current_stock: Number(m.current_stock) || 0,
      min_stock: Number(m.min_stock) || 0, unit_price,
      name: (m.name && m.name.trim()) || `${m.brand} ${m.item}`.trim()
    };
    delete payload._isNew;
    if (m._isNew) {
      if (data.materials.some(x => x.id === m.id)) return pushToast('A material with that ID already exists.', 'warning');
      await insert('materials', payload);
      pushToast('Material added.', 'success');
    } else {
      await update('materials', m.id, payload);
      pushToast('Material updated.', 'success');
    }
    setEditing(null);
  };

  const set = (k, v) => setEditing(e => ({ ...e, [k]: v }));
  const toggleStatus = async (m) => {
    await update('materials', m.id, { status: m.status === 'Active' ? 'Inactive' : 'Active' });
  };
  const cols = [['id', 'ID'], ['category', 'Category'], ['brand', 'Brand'], ['item', 'Item'], ['price', 'Price'], ['unit_price', 'UP']];

  return (
    <div className="card">
      <div className="card-header">
        <h3>Raw Materials Catalog</h3>
        <div className="flex-between" style={{ gap: 12 }}>
          <input className="form-control" style={{ maxWidth: 220 }} placeholder="Search materials..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <button className="btn btn-primary btn-sm" onClick={openNew}><i className="fa-solid fa-plus"></i> Add Material</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {cols.map(([f, l]) => <th key={f} data-sort={f} onClick={() => toggleSort(f)}>{l} <i className={`sort-icon ${sortIcon(f)}`}></i></th>)}
              <th>Barcode</th><th>Qty/Unit</th><th>Yield</th>
              <th data-sort="status" onClick={() => toggleSort('status')}>Status <i className={`sort-icon ${sortIcon('status')}`}></i></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length ? pageRows.map(m => (
              <tr key={m.id}>
                <td><strong>{m.id}</strong></td>
                <td><span className="badge local">{m.category}</span></td>
                <td>{m.brand}</td>
                <td><strong>{m.item}</strong></td>
                <td>{money(m.price)}</td>
                <td>{Number(m.unit_price).toFixed(4)}</td>
                <td>{m.mat_barcode || '-'}</td>
                <td>{m.qty} {m.unit}</td>
                <td>{m.yield}%</td>
                <td>
                  <label className="switch" title="Toggle Active/Inactive">
                    <input type="checkbox" checked={m.status === 'Active'} onChange={() => toggleStatus(m)} />
                    <span className="track"></span>
                    <span className="switch-label">{m.status === 'Active' ? 'Active' : 'Inactive'}</span>
                  </label>
                </td>
                <td><button className="btn btn-sm btn-secondary" onClick={() => openEdit(m)}><i className="fa-solid fa-pen-to-square"></i></button></td>
              </tr>
            )) : <tr className="empty-row"><td colSpan={11}>No materials found.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} onPage={setPage} />

      {editing && (
        <Modal title={editing._isNew ? 'Add Material' : `Edit ${editing.id}`} onClose={() => setEditing(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save}>Save</button>
          </>}>
          <div className="row-2">
            <div className="field"><label>Material ID {editing._isNew ? '(auto)' : ''}</label><input className="form-control" value={editing.id} disabled onChange={(e) => set('id', e.target.value)} /></div>
            <div className="field"><label>Barcode</label><input className="form-control" value={editing.mat_barcode} onChange={(e) => set('mat_barcode', e.target.value)} /></div>
          </div>
          <div className="row-2">
            <div className="field"><label>Category</label><input className="form-control" value={editing.category} onChange={(e) => set('category', e.target.value)} /></div>
            <div className="field"><label>Brand</label><input className="form-control" value={editing.brand} onChange={(e) => set('brand', e.target.value)} /></div>
          </div>
          <div className="field"><label>Item Name</label><input className="form-control" value={editing.item} onChange={(e) => set('item', e.target.value)} /></div>
          <div className="field"><label>Display Name (optional)</label><input className="form-control" value={editing.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="row-2">
            <div className="field"><label>Pack Qty</label><input type="number" className="form-control" value={editing.qty} onChange={(e) => set('qty', e.target.value)} /></div>
            <div className="field"><label>Unit</label><input className="form-control" value={editing.unit} onChange={(e) => set('unit', e.target.value)} /></div>
          </div>
          <div className="row-2">
            <div className="field"><label>Price ฿</label><input type="number" className="form-control" value={editing.price} onChange={(e) => set('price', e.target.value)} /></div>
            <div className="field"><label>Yield %</label><input type="number" className="form-control" value={editing.yield} onChange={(e) => set('yield', e.target.value)} /></div>
          </div>
          <div className="row-2">
            <div className="field"><label>Current Stock</label><input type="number" className="form-control" value={editing.current_stock} onChange={(e) => set('current_stock', e.target.value)} /></div>
            <div className="field"><label>Min Stock</label><input type="number" className="form-control" value={editing.min_stock} onChange={(e) => set('min_stock', e.target.value)} /></div>
          </div>
          <div className="field"><label>Status</label>
            <select className="form-control" value={editing.status} onChange={(e) => set('status', e.target.value)}>
              <option>Active</option><option>Inactive</option>
            </select>
          </div>
        </Modal>
      )}
    </div>
  );
}
