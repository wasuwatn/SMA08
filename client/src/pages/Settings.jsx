import React, { useState, useRef } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { THEMES, TABLES, downloadFile, csvEscape, parseCSVLine } from '../lib/helpers.js';

export default function Settings() {
  const { theme, setTheme, settings, data, update, reload, pushToast } = useData();
  const [sweetness, setSweetness] = useState(settings.sweetness_levels || '');
  const [buyers, setBuyers] = useState(settings.buyers || '');
  const [exportTable, setExportTable] = useState('materials');
  const [importTable, setImportTable] = useState('materials');
  const logoRef = useRef(null);
  const csvRef = useRef(null);
  const jsonRef = useRef(null);

  // ---- Supabase cloud sync ----------------------------------------------
  const [sbUrl, setSbUrl] = useState(localStorage.getItem('KOTEA_SB_URL') || '');
  const [sbKey, setSbKey] = useState(localStorage.getItem('KOTEA_SB_KEY') || '');
  const [sbConnected, setSbConnected] = useState(false);
  const [sbBusy, setSbBusy] = useState('');
  const sbClient = useRef(null);

  const getClient = async () => {
    if (sbClient.current) return sbClient.current;
    const mod = await import(/* @vite-ignore */ 'https://esm.sh/@supabase/supabase-js@2');
    sbClient.current = mod.createClient(sbUrl.trim(), sbKey.trim());
    return sbClient.current;
  };

  const sbConnect = async () => {
    if (!sbUrl.trim() || !sbKey.trim()) return pushToast('Enter your Supabase URL and anon key.', 'warning');
    setSbBusy('connect');
    try {
      sbClient.current = null;
      const client = await getClient();
      const { error } = await client.from('users').select('username').limit(1);
      if (error) throw error;
      localStorage.setItem('KOTEA_SB_URL', sbUrl.trim());
      localStorage.setItem('KOTEA_SB_KEY', sbKey.trim());
      setSbConnected(true);
      pushToast('Connected to Supabase.', 'success');
    } catch (e) {
      setSbConnected(false);
      pushToast(`Supabase connection failed: ${e.message || e}`, 'warning');
    } finally { setSbBusy(''); }
  };

  const sbPush = async () => {
    setSbBusy('push');
    try {
      const client = await getClient();
      let errors = 0;
      for (const t of TABLES) {
        const rows = await api.list(t);
        if (rows.length) {
          const { error } = await client.from(t).upsert(rows);
          if (error) { console.error(t, error); errors++; }
        }
      }
      pushToast(errors ? `Pushed with ${errors} table error(s) — check cloud schema/RLS.` : 'All local data pushed to cloud.', errors ? 'warning' : 'success');
    } catch (e) { pushToast(`Push failed: ${e.message || e}`, 'warning'); }
    finally { setSbBusy(''); }
  };

  const sbPull = async () => {
    if (!confirm('Pull cloud data and overwrite all local data?')) return;
    setSbBusy('pull');
    try {
      const client = await getClient();
      const payload = {};
      for (const t of TABLES) {
        const { data: rows, error } = await client.from(t).select('*');
        if (!error && rows) payload[t] = rows;
      }
      await api.restore(payload);
      await reload();
      pushToast('Local database synced from cloud.', 'success');
    } catch (e) { pushToast(`Pull failed: ${e.message || e}`, 'warning'); }
    finally { setSbBusy(''); }
  };

  const sbDisconnect = () => {
    localStorage.removeItem('KOTEA_SB_URL');
    localStorage.removeItem('KOTEA_SB_KEY');
    sbClient.current = null;
    setSbConnected(false);
    pushToast('Supabase disconnected.', 'info');
  };

  const saveSettings = async () => {
    await update('settings', settings.id, { sweetness_levels: sweetness, buyers });
    pushToast('Store settings saved.', 'success');
  };

  const chooseTheme = async (t) => {
    setTheme(t);
    if (settings.id) await update('settings', settings.id, { current_theme: t });
    pushToast(`Theme changed to ${t}.`, 'success');
  };

  const onLogo = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      await update('settings', settings.id, { logo: ev.target.result });
      pushToast('Store logo updated.', 'success');
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
        <button className="btn btn-primary" onClick={saveSettings}><i className="fa-solid fa-floppy-disk"></i> Save Options</button>
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

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-header">
          <h3>Cloud Sync (Supabase)</h3>
          <span className={`badge ${sbConnected ? 'online' : 'local'}`}><i className="fa-solid fa-circle"></i> {sbConnected ? 'Connected' : 'Not connected'}</span>
        </div>
        <div className="row-2">
          <div className="field"><label>Project URL</label>
            <input className="form-control" value={sbUrl} placeholder="https://xxxx.supabase.co" onChange={(e) => setSbUrl(e.target.value)} />
          </div>
          <div className="field"><label>Anon Key</label>
            <input className="form-control" type="password" value={sbKey} placeholder="eyJ..." onChange={(e) => setSbKey(e.target.value)} />
          </div>
        </div>
        <div className="section-actions">
          <button className="btn btn-secondary" disabled={!!sbBusy} onClick={sbConnect}>
            <i className="fa-solid fa-plug"></i> {sbBusy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
          <button className="btn btn-primary" disabled={!sbConnected || !!sbBusy} onClick={sbPush}>
            <i className="fa-solid fa-cloud-arrow-up"></i> {sbBusy === 'push' ? 'Pushing…' : 'Push local → cloud'}
          </button>
          <button className="btn btn-primary" disabled={!sbConnected || !!sbBusy} onClick={sbPull}>
            <i className="fa-solid fa-cloud-arrow-down"></i> {sbBusy === 'pull' ? 'Pulling…' : 'Pull cloud → local'}
          </button>
          {sbConnected && <button className="btn btn-danger" onClick={sbDisconnect}>Disconnect</button>}
        </div>
        <p className="helper-text">
          Your Supabase project must already contain tables matching this app's schema
          ({TABLES.join(', ')}) with appropriate Row Level Security policies. Push upserts all local
          rows to the cloud; Pull replaces all local data with the cloud copy.
        </p>
      </div>
    </div>
  );
}
