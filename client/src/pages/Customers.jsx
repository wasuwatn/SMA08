import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { useTable } from '../lib/useTable.js';
import Pagination from '../components/Pagination.jsx';
import Modal from '../components/Modal.jsx';

export default function Customers() {
  const { data, insert, update, remove, pushToast } = useData();
  const list = useMemo(() => [...data.customers].sort((a, b) => b.id - a.id), [data.customers]);
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(c => [c.name, c.address, String(c.id)].some(v => String(v || '').toLowerCase().includes(q)));
  }, [list, search]);
  const { pageRows, page, setPage, total, toggleSort, sortIcon } = useTable(filtered);
  const [editing, setEditing] = useState(null);

  const save = async () => {
    if (!editing.name.trim()) return pushToast('Customer name is required.', 'warning');
    const payload = { name: editing.name.trim(), address: editing.address.trim(), gender: editing.gender || 'male' };
    if (editing.id) { await update('customers', editing.id, payload); pushToast('Customer updated.', 'success'); }
    else { await insert('customers', payload); pushToast('Customer added.', 'success'); }
    setEditing(null);
  };
  const del = async (id) => { if (confirm('Delete this customer?')) { await remove('customers', id); pushToast('Customer removed.', 'success'); } };
  const toggleGender = async (c) => {
    const next = c.gender === 'female' ? 'male' : 'female';
    await update('customers', c.id, { gender: next });
  };

  return (
    <div className="card">
      <div className="card-header"><h3>Customer Directory</h3>
        <div className="flex-between" style={{ gap: 12 }}>
          <input className="form-control" style={{ maxWidth: 220 }} placeholder="Search customers..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ name: '', address: '', gender: 'male' })}><i className="fa-solid fa-plus"></i> Add Customer</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th data-sort="id" onClick={() => toggleSort('id')}>ID <i className={`sort-icon ${sortIcon('id')}`}></i></th>
            <th data-sort="name" onClick={() => toggleSort('name')}>Name <i className={`sort-icon ${sortIcon('name')}`}></i></th>
            <th>Address</th><th></th>
          </tr></thead>
          <tbody>
            {pageRows.length ? pageRows.map(c => (
              <tr key={c.id}>
                <td><strong>{c.id}</strong></td>
                <td>
                  <button className="btn btn-sm btn-secondary" style={{ marginRight: 8 }} title={`Gender: ${c.gender === 'female' ? 'Female' : 'Male'} (click to toggle)`} onClick={() => toggleGender(c)}>
                    <i className={`fa-solid ${c.gender === 'female' ? 'fa-person-dress' : 'fa-person'}`}></i>
                  </button>
                  <strong>{c.name}</strong>
                </td>
                <td><span className="helper-text">{c.address || 'N/A'}</span></td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => setEditing(c)}><i className="fa-solid fa-pen-to-square"></i></button>
                  <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => del(c.id)}><i className="fa-solid fa-trash-can"></i></button>
                </td>
              </tr>
            )) : <tr className="empty-row"><td colSpan={4}>No customers found.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} onPage={setPage} />

      {editing && (
        <Modal title={editing.id ? 'Edit Customer' : 'Add Customer'} onClose={() => setEditing(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="field"><label>Name</label><input className="form-control" value={editing.name} autoFocus onChange={(e) => setEditing(c => ({ ...c, name: e.target.value }))} /></div>
          <div className="field"><label>Address</label><input className="form-control" value={editing.address || ''} onChange={(e) => setEditing(c => ({ ...c, address: e.target.value }))} /></div>
          <div className="field"><label>Gender</label>
            <select className="form-control" value={editing.gender || 'male'} onChange={(e) => setEditing(c => ({ ...c, gender: e.target.value }))}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </div>
        </Modal>
      )}
    </div>
  );
}
