import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { useTable } from '../lib/useTable.js';
import Pagination from '../components/Pagination.jsx';
import Modal from '../components/Modal.jsx';

const GENDER_LABEL = { M: 'Male', F: 'Female', NA: 'N/A' };

function parseFavorites(v) {
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

export default function Customers() {
  const { data, insert, update, remove, pushToast } = useData();
  const list = useMemo(() => [...data.customers].sort((a, b) => b.id - a.id), [data.customers]);
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(c => [c.name, c.address, c.phone, c.code, String(c.id)].some(v => String(v || '').toLowerCase().includes(q)));
  }, [list, search]);
  const { pageRows, page, setPage, total, toggleSort, sortIcon } = useTable(filtered);
  const [editing, setEditing] = useState(null);

  const blankCustomer = () => ({ name: '', address: '', phone: '', code: '', gender: 'NA', date_of_birth: '', favorite_menu: [] });

  const save = async () => {
    const name = (editing.name || '').trim();
    if (!name) return pushToast('Customer name is required.', 'warning');
    const payload = {
      name, address: (editing.address || '').trim(), phone: (editing.phone || '').trim(),
      code: (editing.code || '').trim(), gender: editing.gender || 'NA',
      date_of_birth: editing.date_of_birth || null, favorite_menu: editing.favorite_menu || []
    };
    try {
      if (editing.id) { await update('customers', editing.id, payload); pushToast('Customer updated.', 'success'); }
      else { await insert('customers', payload); pushToast('Customer added.', 'success'); }
      setEditing(null);
    } catch (e) {
      pushToast(e.message, 'warning');
    }
  };
  const del = async (id) => { if (confirm('Delete this customer?')) { await remove('customers', id); pushToast('Customer removed.', 'success'); } };
  const toggleEditFavorite = (name) => {
    setEditing(c => {
      const list = c.favorite_menu || [];
      return { ...c, favorite_menu: list.includes(name) ? list.filter(n => n !== name) : [...list, name] };
    });
  };

  return (
    <div className="card">
      <div className="card-header"><h3>Customer Directory</h3>
        <div className="flex-between" style={{ gap: 12 }}>
          <input className="form-control" style={{ maxWidth: 220 }} placeholder="Search customers..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(blankCustomer())}><i className="fa-solid fa-plus"></i> Add Customer</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th data-sort="id" onClick={() => toggleSort('id')}>ID <i className={`sort-icon ${sortIcon('id')}`}></i></th>
            <th>Code</th>
            <th data-sort="name" onClick={() => toggleSort('name')}>Name <i className={`sort-icon ${sortIcon('name')}`}></i></th>
            <th>Phone</th><th>Gender</th><th>DOB</th><th>Favorite Menu</th><th>Address</th><th></th>
          </tr></thead>
          <tbody>
            {pageRows.length ? pageRows.map(c => (
              <tr key={c.id}>
                <td><strong>{c.id}</strong></td>
                <td>{c.code ? <span className="badge local">{c.code}</span> : <span className="helper-text">—</span>}</td>
                <td><strong>{c.name}</strong></td>
                <td><span className="helper-text">{c.phone || 'N/A'}</span></td>
                <td>{GENDER_LABEL[c.gender] || 'N/A'}</td>
                <td><span className="helper-text">{c.date_of_birth || 'N/A'}</span></td>
                <td><span className="helper-text">{parseFavorites(c.favorite_menu).join(', ') || 'N/A'}</span></td>
                <td><span className="helper-text">{c.address || 'N/A'}</span></td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => setEditing({ ...c, favorite_menu: parseFavorites(c.favorite_menu), phone: c.phone || '', code: c.code || '', date_of_birth: c.date_of_birth || '', address: c.address || '' })}><i className="fa-solid fa-pen-to-square"></i></button>
                  <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => del(c.id)}><i className="fa-solid fa-trash-can"></i></button>
                </td>
              </tr>
            )) : <tr className="empty-row"><td colSpan={9}>No customers found.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} onPage={setPage} />

      {editing && (
        <Modal title={editing.id ? 'Edit Customer' : 'Add Customer'} onClose={() => setEditing(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="field"><label>Name</label><input className="form-control" value={editing.name} autoFocus onChange={(e) => setEditing(c => ({ ...c, name: e.target.value }))} /></div>
          <div className="field"><label>Customer Code (staff only, e.g. A001)</label>
            <input className="form-control" value={editing.code} maxLength={4} placeholder="A001"
              onChange={(e) => setEditing(c => ({ ...c, code: e.target.value.toUpperCase() }))} />
          </div>
          <div className="field"><label>Phone</label><input className="form-control" value={editing.phone} onChange={(e) => setEditing(c => ({ ...c, phone: e.target.value }))} /></div>
          <div className="field"><label>Address</label><input className="form-control" value={editing.address || ''} onChange={(e) => setEditing(c => ({ ...c, address: e.target.value }))} /></div>
          <div className="field"><label>Gender</label>
            <select className="form-control" value={editing.gender || 'NA'} onChange={(e) => setEditing(c => ({ ...c, gender: e.target.value }))}>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="NA">N/A</option>
            </select>
          </div>
          <div className="field"><label>Date of Birth</label>
            <input className="form-control" type="date" value={editing.date_of_birth || ''} onChange={(e) => setEditing(c => ({ ...c, date_of_birth: e.target.value }))} />
          </div>
          <div className="field"><label>Favorite Menu</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {data.menuname.map(m => (
                <label key={m.id} className="badge local" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={(editing.favorite_menu || []).includes(m.name)} onChange={() => toggleEditFavorite(m.name)} />
                  {m.name}
                </label>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
