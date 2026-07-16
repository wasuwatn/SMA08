import React, { useState } from 'react';
import { useData } from '../lib/data.jsx';
import { useTable } from '../lib/useTable.js';
import Pagination from '../components/Pagination.jsx';
import Modal from '../components/Modal.jsx';

const ACCESS = [
  ['dashboard', 'Dashboard'], ['pos', 'POS Front'], ['delivery', 'Delivery'],
  ['materials', 'Materials'], ['stock', 'Warehouse'], ['bom', 'Recipes / BOM'],
  ['expenses', 'Expenses'], ['customers', 'Customers / CRM'], ['promotions', 'Promotions'],
  ['points', 'Points'], ['users', 'Users'], ['daily', 'Daily Cups'], ['settings', 'Settings']
];

export default function Users() {
  const { data, insert, update, remove, pushToast } = useData();
  const { pageRows, page, setPage, total } = useTable(data.users);
  const [editing, setEditing] = useState(null); // {username, role, access:[], password, pin, _isNew}

  const openNew = () => setEditing({ username: '', role: 'User', access: [], password: '', pin: '', _isNew: true });
  const openEdit = (u) => setEditing({ username: u.username, role: u.role, access: u.access.split(',').filter(Boolean), password: '', pin: '', _isNew: false });

  const toggle = (key) => setEditing(e => ({ ...e, access: e.access.includes(key) ? e.access.filter(a => a !== key) : [...e.access, key] }));

  const save = async () => {
    const e = editing;
    if (e._isNew && !e.username.trim()) return pushToast('Username is required.', 'warning');
    if (e._isNew && !e.password) return pushToast('Password is required for new accounts.', 'warning');
    if (e.pin && !/^\d{4}$/.test(e.pin)) return pushToast('PIN must be exactly 4 digits.', 'warning');
    const payload = { role: e.role, access: e.access.join(',') };
    if (e.password) payload.password = e.password;
    if (e.pin) payload.pin = e.pin;
    if (e._isNew) {
      if (data.users.some(u => u.username.toLowerCase() === e.username.trim().toLowerCase())) return pushToast('That username already exists.', 'warning');
      await insert('users', { username: e.username.trim(), ...payload });
      pushToast('User account created.', 'success');
    } else {
      await update('users', e.username, payload);
      pushToast('User permissions updated.', 'success');
    }
    setEditing(null);
  };

  const del = async (username) => {
    if (username === 'admin') return pushToast('Cannot remove the root administrator.', 'warning');
    if (confirm(`Remove account "${username}"?`)) { await remove('users', username); pushToast('User account deleted.', 'success'); }
  };

  return (
    <div className="card">
      <div className="card-header"><h3>User Access Control</h3>
        <button className="btn btn-primary btn-sm" onClick={openNew}><i className="fa-solid fa-user-plus"></i> Add User</button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Username</th><th>Role</th><th>Permissions</th><th></th></tr></thead>
          <tbody>
            {pageRows.length ? pageRows.map(u => (
              <tr key={u.username}>
                <td><strong>{u.username}</strong></td>
                <td><span className="badge online">{u.role}</span></td>
                <td>
                  <div className="perm-grid">
                    {ACCESS.map(([key, label]) => {
                      const on = u.role === 'Admin' || u.access.split(',').includes(key);
                      return (
                        <span key={key} className={`perm-chip ${on ? 'on' : ''}`}>
                          <i className={`fa-solid ${on ? 'fa-square-check' : 'fa-square'}`}></i> {label}
                        </span>
                      );
                    })}
                  </div>
                </td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(u)}><i className="fa-solid fa-pen-to-square"></i> Edit</button>
                  <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} disabled={u.username === 'admin'} onClick={() => del(u.username)}><i className="fa-solid fa-trash-can"></i></button>
                </td>
              </tr>
            )) : <tr className="empty-row"><td colSpan={4}>No users.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={total} onPage={setPage} />

      {editing && (
        <Modal title={editing._isNew ? 'Add User' : `Edit ${editing.username}`} onClose={() => setEditing(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Username</label><input className="form-control" value={editing.username} disabled={!editing._isNew} onChange={(e) => setEditing(s => ({ ...s, username: e.target.value }))} /></div>
            <div className="field"><label>Role</label>
              <select className="form-control" value={editing.role} onChange={(e) => setEditing(s => ({ ...s, role: e.target.value }))}><option>User</option><option>Admin</option></select>
            </div>
          </div>
          <div className="field"><label>{editing._isNew ? 'Password' : 'New Password (leave blank to keep)'}</label>
            <input type="password" className="form-control" value={editing.password} onChange={(e) => setEditing(s => ({ ...s, password: e.target.value }))} />
          </div>
          <div className="field"><label>{editing._isNew ? 'PIN (4 digits, optional)' : 'New PIN (leave blank to keep)'}</label>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              className="form-control"
              value={editing.pin}
              onChange={(e) => setEditing(s => ({ ...s, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
            />
            <p className="helper-text">Used to log into the POS app. Leave blank if this staff member won't use POS PIN login.</p>
          </div>
          <p className="card-title-sm">Tab Permissions</p>
          <p className="helper-text mb-12">Admins always have full access regardless of these checkboxes.</p>
          <div className="grid-2">
            {ACCESS.map(([key, label]) => (
              <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={editing.access.includes(key)} onChange={() => toggle(key)} /> {label}
              </label>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
