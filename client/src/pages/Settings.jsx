import React, { useState, useRef } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { THEMES, TABLES, downloadFile, csvEscape, parseCSVLine, money, nextSeqId } from '../lib/helpers.js';
import Modal from '../components/Modal.jsx';

const blankMenu = { id: '', name: '', category: '', front_price: 0, delivery_price: 0, status: 'Active' };
const blankCategory = { name: '' };
const blankModifier = { name: '', price_change: 0 };

export default function Settings() {
  const { theme, setTheme, settings, data, insert, update, remove, reload, pushToast } = useData();
  const [sweetness, setSweetness] = useState(settings.sweetness_levels || '');
  const [buyers, setBuyers] = useState(settings.buyers || '');
  const [menuModal, setMenuModal] = useState(null);
  const [categoryModal, setCategoryModal] = useState(null);
  const [modifierModal, setModifierModal] = useState(null);
  // Receipt & payment (printed on the 58mm slip; PromptPay ID drives the POS QR)
  const [shopName, setShopName] = useState(settings.shop_name || '');
  const [shopAddress, setShopAddress] = useState(settings.shop_address || '');
  const [shopPhone, setShopPhone] = useState(settings.shop_phone || '');
  const [promptpayId, setPromptpayId] = useState(settings.promptpay_id || '');
  const [receiptFooter, setReceiptFooter] = useState(settings.receipt_footer || '');
  const [exportTable, setExportTable] = useState('materials');
  const [importTable, setImportTable] = useState('materials');
  const logoRef = useRef(null);
  const csvRef = useRef(null);
  const jsonRef = useRef(null);

  const saveSettings = async () => {
    await update('settings', settings.id, { sweetness_levels: sweetness, buyers });
    pushToast('Store settings saved.', 'success');
  };

  const saveReceipt = async () => {
    await update('settings', settings.id, {
      shop_name: shopName, shop_address: shopAddress, shop_phone: shopPhone,
      promptpay_id: promptpayId, receipt_footer: receiptFooter
    });
    pushToast('Receipt & payment settings saved.', 'success');
  };

  const chooseTheme = (t) => {
    setTheme(t); // persisted to localStorage by the data layer
    pushToast(`Theme changed to ${t}.`, 'success');
  };

  // The logo is stored as a base64 data URL inside the settings row, and that
  // row is fetched on every login/reload — an oversized "logo" would bloat
  // every page load for every device, not just the one that uploaded it.
  const MAX_LOGO_BYTES = 300 * 1024; // 300KB — generous for a small store logo

  const onLogo = (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      pushToast(`Logo must be under ${Math.round(MAX_LOGO_BYTES / 1024)}KB (this file is ${Math.round(file.size / 1024)}KB).`, 'warning');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        await update('settings', settings.id, { logo: ev.target.result });
        pushToast('Store logo updated.', 'success');
      } catch (err) {
        pushToast(err.message || 'Could not save logo.', 'warning');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  const resetLogo = async () => { await update('settings', settings.id, { logo: null }); pushToast('Logo reset to default.', 'info'); };

  // ---- CSV ---------------------------------------------------------------
  const exportCSV = () => {
    const list = data[exportTable] || [];
    if (!list.length) return pushToast(`Table ${exportTable} is empty.`, 'warning');
    const headers = Object.keys(list[0]);
    const rows = [headers.join(',')];
    list.forEach(r => rows.push(headers.map(h => csvEscape(r[h])).join(',')));
    downloadFile(`KOTEA_${exportTable}_${Date.now()}.csv`, '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8;');
    pushToast('CSV exported.', 'success');
  };

  const templates = () => {
    let bundle = 'KOTEA Cozy Cafe CSV Import Schemas\r\n\r\n';
    TABLES.forEach(t => {
      const sample = (data[t] || [])[0];
      if (sample) bundle += `[TABLE: ${t}]\r\n${Object.keys(sample).join(',')}\r\n\r\n`;
    });
    downloadFile('KOTEA_CSV_Schemas.txt', bundle);
  };

  const onImportCSV = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim().length);
      if (lines.length < 2) { pushToast('CSV is empty or missing data rows.', 'warning'); return; }
      const headers = parseCSVLine(lines[0]);
      const key = importTable === 'users' ? 'username' : 'id';
      const existing = data[importTable] || [];
      let count = 0;
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length !== headers.length) continue;
        const obj = {};
        headers.forEach((h, idx) => {
          let v = values[idx];
          if (/^-?\d+$/.test(v)) v = parseInt(v, 10);
          else if (/^-?\d+\.\d+$/.test(v)) v = parseFloat(v);
          obj[h] = v;
        });
        const found = existing.find(x => String(x[key]) === String(obj[key]));
        if (found && obj[key] !== undefined && obj[key] !== '') await api.update(importTable, obj[key], obj);
        else await api.insert(importTable, obj);
        count++;
      }
      await reload(importTable);
      pushToast(`Imported ${count} records into ${importTable}.`, 'success');
    } catch {
      pushToast('Failed to parse CSV file.', 'warning');
    }
    e.target.value = '';
  };

  // ---- JSON --------------------------------------------------------------
  const exportJSON = async () => {
    const backup = await api.backup();
    downloadFile(`KOTEA_Backup_${new Date().toISOString().split('T')[0]}.json`, JSON.stringify(backup, null, 2), 'application/json');
    pushToast('Backup downloaded.', 'success');
  };
  const onImportJSON = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      await api.restore(payload);
      await reload();
      pushToast('Database restored successfully.', 'success');
    } catch {
      pushToast('Failed to restore backup.', 'warning');
    }
    e.target.value = '';
  };

  // ---- Menu (quick add/edit, separate from the full BOM/recipe composer on
  // the Recipes page — this is just the menuname row: name, category, price) ---
  const saveMenu = async () => {
    const m = menuModal;
    if (!m.id.trim() || !m.name.trim()) return pushToast('Drink ID and name are required.', 'warning');
    const payload = { ...m, front_price: Number(m.front_price) || 0, delivery_price: Number(m.delivery_price) || 0 };
    delete payload._isNew;
    if (m._isNew) {
      if (data.menuname.some(x => x.id === m.id)) return pushToast('That drink ID already exists.', 'warning');
      await insert('menuname', payload);
    } else await update('menuname', m.id, payload);
    pushToast('Menu item saved.', 'success');
    setMenuModal(null);
  };
  const delMenu = async (m) => { if (confirm(`Delete menu item "${m.name}"?`)) { await remove('menuname', m.id); pushToast('Menu item deleted.', 'success'); } };

  // ---- Category -----------------------------------------------------------
  const saveCategory = async () => {
    const c = categoryModal;
    if (!c.name.trim()) return pushToast('Category name is required.', 'warning');
    const payload = { name: c.name.trim() };
    if (c._isNew) await insert('categories', payload);
    else await update('categories', c.id, payload);
    pushToast('Category saved.', 'success');
    setCategoryModal(null);
  };
  const delCategory = async (c) => { if (confirm(`Delete category "${c.name}"?`)) { await remove('categories', c.id); pushToast('Category deleted.', 'success'); } };

  // ---- Modifier (same as Recipes' Add-on Options — shares the addons table) --
  const saveModifier = async () => {
    const a = modifierModal;
    if (!a.name.trim()) return pushToast('Modifier name is required.', 'warning');
    const payload = { name: a.name.trim(), price_change: Number(a.price_change) || 0 };
    if (a._isNew) await insert('addons', payload);
    else await update('addons', a.id, payload);
    pushToast('Modifier saved.', 'success');
    setModifierModal(null);
  };
  const delModifier = async (a) => { if (confirm(`Delete modifier "${a.name}"?`)) { await remove('addons', a.id); pushToast('Modifier deleted.', 'success'); } };

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-header"><h3>Appearance</h3></div>
        <p className="card-title-sm">Seasonal Theme</p>
        <div className="theme-grid mb-12">
          {THEMES.map(t => (
            <div key={t.id} className={`theme-option ${theme === t.id ? 'selected' : ''}`} onClick={() => chooseTheme(t.id)}>
              <div className="theme-stripe">{t.colors.map((c, i) => <span key={i} style={{ background: c }} />)}</div>
              <div className="name">{t.label}</div>
            </div>
          ))}
        </div>
        <p className="card-title-sm">Store Logo</p>
        <div className="section-actions">
          <button className="btn btn-secondary" onClick={() => logoRef.current.click()}><i className="fa-solid fa-image"></i> Upload Logo</button>
          <button className="btn btn-secondary" onClick={resetLogo}>Reset</button>
          <input ref={logoRef} type="file" accept="image/*" hidden onChange={onLogo} />
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3>Store Options</h3></div>
        <div className="field"><label>Sweetness Levels (comma separated)</label>
          <input className="form-control" value={sweetness} onChange={(e) => setSweetness(e.target.value)} />
        </div>
        <div className="field"><label>Buyers (comma separated)</label>
          <input className="form-control" value={buyers} onChange={(e) => setBuyers(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={saveSettings}><i className="fa-solid fa-floppy-disk"></i> Save Options</button>
      </div>

      <div className="card">
        <div className="card-header"><h3>Receipt &amp; Payment</h3></div>
        <div className="field"><label>Shop name (receipt header)</label>
          <input className="form-control" value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="KOTEA" />
        </div>
        <div className="row-2">
          <div className="field"><label>Address</label>
            <input className="form-control" value={shopAddress} onChange={(e) => setShopAddress(e.target.value)} />
          </div>
          <div className="field"><label>Phone</label>
            <input className="form-control" value={shopPhone} onChange={(e) => setShopPhone(e.target.value)} />
          </div>
        </div>
        <div className="field"><label>PromptPay ID (phone or 13-digit tax ID — enables the POS QR)</label>
          <input className="form-control" value={promptpayId} onChange={(e) => setPromptpayId(e.target.value)} placeholder="0812345678" />
        </div>
        <div className="field"><label>Receipt footer message</label>
          <input className="form-control" value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} placeholder="Thank you! See you again" />
        </div>
        <button className="btn btn-primary" onClick={saveReceipt}><i className="fa-solid fa-floppy-disk"></i> Save Receipt Settings</button>
      </div>

      <div className="card">
        <div className="card-header"><h3>หมวดหมู่</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setCategoryModal({ ...blankCategory, _isNew: true })}><i className="fa-solid fa-plus"></i> Add Category</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th style={{ width: 1, textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {data.categories.length ? data.categories.map(c => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => setCategoryModal({ ...c, _isNew: false })}><i className="fa-solid fa-pen-to-square"></i></button>
                    <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delCategory(c)}><i className="fa-solid fa-trash-can"></i></button>
                  </td>
                </tr>
              )) : <tr className="empty-row"><td colSpan={2}>No categories yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3>เพิ่มเมนู</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setMenuModal({ ...blankMenu, id: nextSeqId('MN', data.menuname), _isNew: true })}><i className="fa-solid fa-plus"></i> Add Menu</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Front</th><th>Delivery</th><th>Status</th><th style={{ width: 1, textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {data.menuname.length ? data.menuname.map(m => (
                <tr key={m.id}>
                  <td><strong>{m.name}</strong><br /><span className="helper-text">{m.category}</span></td>
                  <td>{money(m.front_price)}</td>
                  <td>{money(m.delivery_price)}</td>
                  <td><span className={`badge ${m.status === 'Active' ? 'online' : 'offline'}`}>{m.status}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => setMenuModal({ ...m, _isNew: false })}><i className="fa-solid fa-pen-to-square"></i></button>
                    <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delMenu(m)}><i className="fa-solid fa-trash-can"></i></button>
                  </td>
                </tr>
              )) : <tr className="empty-row"><td colSpan={5}>No menu items yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3>Modifier</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setModifierModal({ ...blankModifier, _isNew: true })}><i className="fa-solid fa-plus"></i> Add Modifier</button>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Price Change</th><th style={{ width: 1, textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {data.addons.length ? data.addons.map(a => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><span className="helper-text">+{money(a.price_change)}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-secondary" onClick={() => setModifierModal({ ...a, _isNew: false })}><i className="fa-solid fa-pen-to-square"></i></button>
                    <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delModifier(a)}><i className="fa-solid fa-trash-can"></i></button>
                  </td>
                </tr>
              )) : <tr className="empty-row"><td colSpan={3}>No modifiers yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3>CSV Data Tools</h3></div>
        <p className="card-title-sm">Export Table</p>
        <div className="input-group mb-12">
          <select className="form-control" value={exportTable} onChange={(e) => setExportTable(e.target.value)}>
            {TABLES.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
          </select>
          <button className="btn btn-secondary" onClick={exportCSV}><i className="fa-solid fa-file-csv"></i> Export</button>
        </div>
        <p className="card-title-sm">Import Table (upsert)</p>
        <div className="input-group mb-12">
          <select className="form-control" value={importTable} onChange={(e) => setImportTable(e.target.value)}>
            {TABLES.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
          </select>
          <button className="btn btn-secondary" onClick={() => csvRef.current.click()}><i className="fa-solid fa-upload"></i> Import</button>
          <input ref={csvRef} type="file" accept=".csv" hidden onChange={onImportCSV} />
        </div>
        <button className="btn btn-secondary btn-sm" onClick={templates}><i className="fa-solid fa-download"></i> Download Schema Templates</button>
      </div>

      <div className="card">
        <div className="card-header"><h3>Backup & Restore</h3></div>
        <p className="helper-text mb-12">Export the entire database as a JSON file, or restore from a previous backup. Restoring replaces all current data.</p>
        <div className="section-actions">
          <button className="btn btn-primary" onClick={exportJSON}><i className="fa-solid fa-cloud-arrow-down"></i> Export JSON Backup</button>
          <button className="btn btn-danger" onClick={() => jsonRef.current.click()}><i className="fa-solid fa-cloud-arrow-up"></i> Restore Backup</button>
          <input ref={jsonRef} type="file" accept=".json" hidden onChange={onImportJSON} />
        </div>
      </div>

      {categoryModal && (
        <Modal title={categoryModal._isNew ? 'Add Category' : `Edit ${categoryModal.name}`} onClose={() => setCategoryModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setCategoryModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveCategory}>Save</button></>}>
          <div className="field"><label>Name</label>
            <input className="form-control" value={categoryModal.name} onChange={(e) => setCategoryModal(c => ({ ...c, name: e.target.value }))} />
          </div>
        </Modal>
      )}

      {menuModal && (
        <Modal title={menuModal._isNew ? 'Add Menu' : `Edit ${menuModal.name}`} onClose={() => setMenuModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setMenuModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveMenu}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Menu ID {menuModal._isNew ? '(auto)' : ''}</label><input className="form-control" value={menuModal.id} disabled /></div>
            <div className="field"><label>Category</label>
              <select className="form-control" value={menuModal.category} onChange={(e) => setMenuModal(m => ({ ...m, category: e.target.value }))}>
                <option value="">-- Category --</option>
                {data.categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div className="field"><label>Name</label><input className="form-control" value={menuModal.name} onChange={(e) => setMenuModal(m => ({ ...m, name: e.target.value }))} /></div>
          <div className="row-2">
            <div className="field"><label>Front Price</label><input type="number" className="form-control" value={menuModal.front_price} onChange={(e) => setMenuModal(m => ({ ...m, front_price: e.target.value }))} /></div>
            <div className="field"><label>Delivery Price</label><input type="number" className="form-control" value={menuModal.delivery_price} onChange={(e) => setMenuModal(m => ({ ...m, delivery_price: e.target.value }))} /></div>
          </div>
          <div className="field"><label>Status</label>
            <select className="form-control" value={menuModal.status} onChange={(e) => setMenuModal(m => ({ ...m, status: e.target.value }))}><option>Active</option><option>Inactive</option></select>
          </div>
        </Modal>
      )}

      {modifierModal && (
        <Modal title={modifierModal._isNew ? 'Add Modifier' : `Edit ${modifierModal.name}`} onClose={() => setModifierModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setModifierModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveModifier}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Name</label><input className="form-control" value={modifierModal.name} onChange={(e) => setModifierModal(a => ({ ...a, name: e.target.value }))} /></div>
            <div className="field"><label>Price Change</label><input type="number" className="form-control" value={modifierModal.price_change} onChange={(e) => setModifierModal(a => ({ ...a, price_change: e.target.value }))} /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
