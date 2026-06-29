import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { today, money } from '../lib/helpers.js';
import { api } from '../lib/api.js';
import { useTable } from '../lib/useTable.js';
import Pagination from '../components/Pagination.jsx';
import Modal from '../components/Modal.jsx';

// Level bar: % of min_stock on hand.
function levelPct(m) {
  const cur = Number(m.current_stock), min = Number(m.min_stock);
  return min > 0 ? (cur / min) * 100 : (cur > 0 ? 100 : 0);
}

// Stock status by % of min_stock: Reorder <20%, Low 20-40%, OK >=40%.
function stockStatus(m) {
  const pct = levelPct(m);
  if (pct < 20) return 'Reorder';
  if (pct < 40) return 'Low';
  return 'OK';
}

const STATUS_META = {
  Reorder: { badge: 'reorder' },
  Low: { badge: 'low' },
  OK: { badge: 'ok' }
};

function levelColor(pct) {
  if (pct < 20) return 'var(--warning-color)';
  if (pct < 40) return 'var(--gold)';
  return 'var(--success-color)';
}

const FILTERS = ['All', 'Reorder', 'Low', 'OK'];

export default function Inventory() {
  const { data, reload, pushToast } = useData();
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [rcat, setRcat] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [amount, setAmount] = useState(0);

  // Consumption recorded today (negative stocklog entries).
  const usedToday = (id) => Math.abs(
    data.stocklog
      .filter(l => l.material_id === id && l.date === today() && Number(l.qty_changed) < 0)
      .reduce((s, l) => s + Number(l.qty_changed), 0)
  );

  const skus = data.materials.length;
  const belowMin = data.materials.filter(m => levelPct(m) < 100).length;
  const stockValue = data.materials.reduce((s, m) => s + Number(m.current_stock) * Number(m.unit_price || 0), 0);

  const filteredByStatus = filter === 'All' ? data.materials : data.materials.filter(m => stockStatus(m) === filter);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return filteredByStatus;
    return filteredByStatus.filter(m => [m.item, m.name, m.category, m.brand].some(v => String(v || '').toLowerCase().includes(q)));
  }, [filteredByStatus, search]);
  const { pageRows, page, setPage, total, toggleSort, sortIcon } = useTable(rows);

  const categories = [...new Set(data.materials.map(m => m.category))];
  const matsInCat = (c) => data.materials.filter(m => m.category === c);

  const openModal = () => {
    const c = categories[0] || '';
    setRcat(c);
    setMaterialId(matsInCat(c)[0]?.id || '');
    setAmount(0); setOpen(true);
  };
  const changeCat = (c) => { setRcat(c); setMaterialId(matsInCat(c)[0]?.id || ''); };

  const receive = async () => {
    const add = Number(amount) || 0;
    if (!materialId) return pushToast('Choose a material.', 'warning');
    if (add === 0) return pushToast('Enter a non-zero amount.', 'warning');
    const mat = data.materials.find(m => m.id === materialId);
    await api.update('materials', materialId, { current_stock: Number(mat.current_stock) + add });
    await api.insert('stocklog', { date: today(), material_id: materialId, action: 'Manual Adjust', qty_changed: add, note: 'Warehouse restock' });
    await reload(['materials', 'stocklog']);
    pushToast(`Stock adjusted for ${mat.item}.`, 'success');
    setOpen(false);
  };

  const selectedMat = data.materials.find(m => m.id === materialId);

  return (
    <>
      <div className="kpi-grid kpi-grid-3 mb-12">
        <div className="kpi">
          <div className="label"><i className="fa-solid fa-layer-group"></i> SKUs tracked</div>
          <div className="value">{skus}</div>
        </div>
        <div className="kpi">
          <div className="label"><i className="fa-solid fa-box-open"></i> Below minimum</div>
          <div className="value">{belowMin}</div>
          {belowMin > 0 && <div className="kpi-note warn"><i className="fa-solid fa-arrow-down"></i> order today</div>}
        </div>
        <div className="kpi">
          <div className="label"><i className="fa-solid fa-coins"></i> Stock value</div>
          <div className="value">{money(stockValue)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3>Stock levels</h3>
            <div className="helper-text">Usage is consumed automatically from POS sales via BOM</div>
          </div>
          <div className="flex-between" style={{ gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <input className="form-control" style={{ maxWidth: 160 }} placeholder="Search materials..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            <div className="seg">
              {FILTERS.map(f => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => { setFilter(f); setPage(1); }}>{f}</button>
              ))}
            </div>
            <button className="btn btn-primary btn-sm" onClick={openModal}><i className="fa-solid fa-plus"></i> Receive</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th data-sort="item" onClick={() => toggleSort('item')}>Material <i className={`sort-icon ${sortIcon('item')}`}></i></th>
                <th data-sort="current_stock" onClick={() => toggleSort('current_stock')} style={{ textAlign: 'right' }}>On hand <i className={`sort-icon ${sortIcon('current_stock')}`}></i></th>
                <th data-sort="min_stock" onClick={() => toggleSort('min_stock')} style={{ textAlign: 'right' }}>Min <i className={`sort-icon ${sortIcon('min_stock')}`}></i></th>
                <th>Level</th>
                <th style={{ textAlign: 'right' }}>Used today</th>
                <th style={{ textAlign: 'right' }}>Days left</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length ? pageRows.map(m => {
                const status = stockStatus(m);
                const meta = STATUS_META[status];
                const cur = Number(m.current_stock), min = Number(m.min_stock);
                const rawPct = levelPct(m);
                const pct = Math.min(100, rawPct);
                const used = usedToday(m.id);
                const daysLeft = used > 0 ? (cur / used).toFixed(1) : '—';
                return (
                  <tr key={m.id}>
                    <td><strong>{m.name || m.item}</strong></td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{cur.toLocaleString()} {m.unit}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{min.toLocaleString()} {m.unit}</td>
                    <td><div className="hbar"><span style={{ width: `${pct}%`, background: levelColor(rawPct) }}></span></div></td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{used > 0 ? `${used.toLocaleString()} ${m.unit}` : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{daysLeft}</td>
                    <td><span className={`badge ${meta.badge}`}><i className="fa-solid fa-circle"></i> {status}</span></td>
                  </tr>
                );
              }) : <tr className="empty-row"><td colSpan={7}>No materials found.</td></tr>}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={total} onPage={setPage} />
      </div>

      {open && (
        <Modal title="Receive Stock" onClose={() => setOpen(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={receive}>Apply</button>
          </>}>
          <div className="field"><label>Category</label>
            <select className="form-control" value={rcat} onChange={(e) => changeCat(e.target.value)}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field"><label>Material</label>
            <select className="form-control" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
              <option value="">-- Choose Item --</option>
              {matsInCat(rcat).map(m => <option key={m.id} value={m.id}>{m.id} — {m.item} ({m.current_stock} {m.unit})</option>)}
            </select>
          </div>
          {selectedMat && <p className="helper-text mb-12">Current stock: <strong>{selectedMat.current_stock} {selectedMat.unit}</strong></p>}
          <div className="field"><label>Amount to add{selectedMat ? ` (${selectedMat.unit})` : ''}</label>
            <input type="number" className="form-control" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} />
          </div>
          <p className="helper-text">Use a negative value to subtract stock. A warehouse log entry is recorded.</p>
        </Modal>
      )}
    </>
  );
}
