import React, { useState, useRef } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { THEMES, TABLES, downloadFile, csvEscape, parseCSVLine } from '../lib/helpers.js';

export default function Settings() {
  const { theme, setTheme, settings, data, update, reload, pushToast } = useData();
  const [sweetness, setSweetness] = useState(settings.sweetness_levels || '');
  const [buyers, setBuyers] = useState(settings.buyers || '');
  const [expenseLineUsers, setExpenseLineUsers] = useState(settings.expense_line_users || '');
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
    await update('settings', settings.id, { sweetness_levels: sweetness, buyers, expense_line_users: expenseLineUsers });
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
        <div className="field"><label>LINE expense users (Uxxxx:ชื่อ, comma separated)</label>
          <input className="form-control" value={expenseLineUsers} onChange={(e) => setExpenseLineUsers(e.target.value)}
            placeholder="U1234abcd:สมชาย, U5678efgh:สมหญิง" />
          <small className="text-muted">ผู้ที่บันทึกรายจ่ายผ่านแชท LINE OA ได้ — ดู user ID ได้จาก server log เมื่อคนที่ยังไม่อยู่ในรายชื่อทักแชทมา หรือให้คนที่อยู่แล้วพิมพ์ myid</small>
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
    </div>
  );
}
