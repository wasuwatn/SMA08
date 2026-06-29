import React, { useState, useMemo, useRef } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money, today, computeRequirements, DELIVERY_HEADER_ALIASES, parseCSVLine, splitComboName, decomposeDeliveryMenu } from '../lib/helpers.js';
import { parseXlsxRows } from '../lib/xlsx.js';

export default function Delivery() {
  const { user, data, reload, remove, pushToast } = useData();

  const [view, setView] = useState('import');

  // ---- Import (Wongnai daily/menu CSV) -----------------------------------
  const [dailyRows, setDailyRows] = useState([]);
  const [menuRows, setMenuRows] = useState([]);
  const [dailyFileName, setDailyFileName] = useState('');
  const [menuFileName, setMenuFileName] = useState('');
  const dailyFileRef = useRef(null);
  const menuFileRef = useRef(null);
  const [importing, setImporting] = useState(false);

  const REQUIRED_COLS = { daily: 'date', menu: 'menuName' };

  // Try delimiters in order of how unambiguous they are: a real tab or comma
  // is never part of a value here, but "," can appear inside quoted text and
  // ";"/whitespace are used by some locales/exports. Pick the first delimiter
  // that actually splits the header into more than one column.
  const splitRow = (line) => {
    for (const delim of ['\t', ',', ';']) {
      if (line.includes(delim)) {
        const cells = parseCSVLine(line, delim);
        if (cells.length > 1) return cells;
      }
    }
    return line.trim().split(/\s+/);
  };

  // Parses delimited text into row arrays (row 0 = normalized header).
  const parseDelimitedRows = (text) => {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    const header = splitRow(lines[0]).map(h => DELIVERY_HEADER_ALIASES[h.trim().toLowerCase()] || h.trim());
    return [header, ...lines.slice(1).map(splitRow)];
  };

  // Converts row arrays (row 0 = header) into objects keyed by header.
  const rowsToObjects = (rows) => {
    if (!rows.length) return [];
    const [header, ...body] = rows;
    return body.map(cells => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  };

  const onFile = (e, kind) => {
    const file = e.target.files[0]; if (!file) return;
    const isXlsx = /\.xlsx$/i.test(file.name);
    const setFileName = kind === 'daily' ? setDailyFileName : setMenuFileName;
    setFileName(file.name);
    const handle = (rows) => {
      const objects = rowsToObjects(rows);
      const col = REQUIRED_COLS[kind];
      if (!objects.length || !objects[0][col]) {
        pushToast(`Couldn't find column "${col}" in this file. Check it has a header row with "${col}"${kind === 'daily' ? ' (or "time")' : ''}.`, 'warning');
        if (kind === 'daily') setDailyRows([]); else setMenuRows([]);
        return;
      }
      if (kind === 'daily') setDailyRows(objects); else setMenuRows(objects);
      pushToast(`Loaded ${objects.length} ${kind} row(s).`, 'success');
    };
    if (isXlsx) {
      file.arrayBuffer()
        .then(parseXlsxRows)
        .then(handle)
        .catch(err => pushToast(`Couldn't read .xlsx file: ${err.message}`, 'warning'));
    } else {
      file.text()
        .then(text => handle(parseDelimitedRows(text)))
        .catch(err => pushToast(`Couldn't read file: ${err.message}`, 'warning'));
    }
  };

  // Decomposed combo view + which drink names will be auto-created.
  const comp = useMemo(() => decomposeDeliveryMenu(menuRows), [menuRows]);
  const existingNames = useMemo(() => new Set(data.menuname.map(m => String(m.name).toLowerCase())), [data.menuname]);
  const willCreate = useMemo(() => Object.keys(comp).filter(n => !existingNames.has(n.toLowerCase())), [comp, existingNames]);
  const importPeriod = useMemo(() => {
    const d = dailyRows.map(r => r.date).filter(Boolean).sort();
    return d.length ? { start: d[0], end: d[d.length - 1] } : { start: '', end: '' };
  }, [dailyRows]);
  const importGross = useMemo(() => dailyRows.reduce((s, r) => s + (Number(r.sales) || 0), 0), [dailyRows]);

  const doImport = async () => {
    if (!dailyRows.length && !menuRows.length) return pushToast('Load at least one CSV first.', 'warning');
    setImporting(true);
    try {
      // Unit price for auto-created menus (only derivable from single-item rows).
      const priceMap = {};
      menuRows.forEach(m => {
        const parts = splitComboName(m.menuName);
        const amt = Number(m.amount) || 0;
        if (parts.length === 1 && amt > 0) priceMap[parts[0]] = (Number(m.sales) || 0) / amt;
      });
      const newMenus = willCreate.map(n => ({ name: n, delivery_price: priceMap[n] || 0 }));
      // Requirements: aggregate BOM for every component that already has one.
      const reqObj = {};
      Object.entries(comp).forEach(([name, qty]) => {
        const r = computeRequirements([{ name, qty }], data.bom, data.packagingbom, data.childmenu, data.matprepbom);
        Object.entries(r).forEach(([mid, amt]) => { reqObj[mid] = (reqObj[mid] || 0) + amt; });
      });
      const note = `Delivery import ${importPeriod.start}–${importPeriod.end}`;
      const requirements = Object.entries(reqObj).map(([material_id, qty]) => ({ material_id, qty, note }));
      const res = await api.importDelivery({ daily: dailyRows, menu: menuRows, newMenus, requirements, period: importPeriod, source: 'Wongnai' });
      await reload(['deliverydaily', 'deliverymenu', 'menuname', 'materials', 'stocklog']);
      const parts = [`${res.days} day(s)`, `${res.menuRows} menu row(s)`];
      if (res.created?.length) parts.push(`${res.created.length} new menu(s)`);
      parts.push(res.firstImport ? `${res.deducted} stock line(s) deducted` : 're-import: stock unchanged');
      pushToast(`Imported — ${parts.join(', ')}.`, 'success');
      setDailyRows([]); setMenuRows([]);
      setDailyFileName(''); setMenuFileName('');
    } catch (e) {
      pushToast(`Import failed: ${e.message}`, 'warning');
    } finally { setImporting(false); }
  };

  const dailyLog = useMemo(() => [...(data.deliverydaily || [])].sort((a, b) => String(b.date).localeCompare(String(a.date))), [data.deliverydaily]);
  const menuLog = useMemo(() => [...(data.deliverymenu || [])].sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0)), [data.deliverymenu]);

  // ---- Delivery promotions (recorded manually as an expense) -------------
  // Wongnai doesn't export the promotions report, so the user reads the
  // discount amount for each campaign off the campaign report page
  // (merchant.wongnai.com/report/campaigns) for a date range and logs
  // them here as separate expenses.
  const PROMO_CAMPAIGNS = [
    { id: 'free_shipping', label: 'ส่งฟรี 0 บาท' },
    { id: 'hot_code', label: 'โค้ดเดือด' },
    { id: 'new_customer', label: 'ร้านที่ไม่เคยลอง' },
    { id: 'lineman_bonus', label: 'LINE MAN BONUS' }
  ];

  const [promoStart, setPromoStart] = useState('');
  const [promoEnd, setPromoEnd] = useState('');
  const [promoAmounts, setPromoAmounts] = useState({});
  const [promoSaving, setPromoSaving] = useState(false);

  const promoDescFor = (campaign) => `Delivery Promotion - ${campaign.label} (Wongnai) ${promoStart}–${promoEnd}`;

  const existingPromos = useMemo(() => {
    const map = {};
    PROMO_CAMPAIGNS.forEach(c => {
      map[c.id] = data.expenses.find(e => e.category === 'Delivery Promotion' && e.description === promoDescFor(c));
    });
    return map;
  }, [data.expenses, promoStart, promoEnd]);

  const promoTotal = useMemo(
    () => PROMO_CAMPAIGNS.reduce((sum, c) => sum + (Number(promoAmounts[c.id]) || 0), 0),
    [promoAmounts]
  );

  const submitPromo = async () => {
    if (!promoStart || !promoEnd) return pushToast('Enter the report period (start and end date).', 'warning');
    const entries = PROMO_CAMPAIGNS.map(c => ({ campaign: c, amount: Number(promoAmounts[c.id]) || 0 })).filter(e => e.amount > 0);
    if (!entries.length) return pushToast('Enter at least one campaign discount amount.', 'warning');

    const replacing = entries.filter(e => existingPromos[e.campaign.id]);
    if (replacing.length) {
      const lines = replacing.map(e => `${e.campaign.label}: ${money(existingPromos[e.campaign.id].amount)} → ${money(e.amount)}`).join('\n');
      if (!confirm(`Some campaigns for ${promoStart}–${promoEnd} are already logged:\n${lines}\n\nReplace them?`)) return;
    }

    setPromoSaving(true);
    try {
      for (const { campaign, amount } of entries) {
        const existing = existingPromos[campaign.id];
        if (existing) await remove('expenses', existing.id);
        await api.expense({
          expense: {
            date: promoEnd, description: promoDescFor(campaign),
            category: 'Delivery Promotion', amount, buyer: user.username, mat_barcode: '', replenishment_id: null,
            qty: 1, unit: 'pcs', price: amount, discount: 0, shipping_cost: 0,
            note: `ค่าส่วนลดให้ลูกค้า - ${campaign.label} from Wongnai campaign report, period ${promoStart}–${promoEnd}`
          },
          restock: null
        });
      }
      await reload(['expenses']);
      pushToast('Promotion discount(s) logged as expense.', 'success');
      setPromoAmounts({});
    } catch (e) {
      pushToast(`Failed to log expense: ${e.message}`, 'warning');
    } finally { setPromoSaving(false); }
  };

  return (
    <>
    <div className="page-area">
      <div className="sub-tabs">
        <button className={`stab ${view === 'import' ? 'on' : ''}`} onClick={() => setView('import')}>Import (CSV)</button>
        <button className={`stab ${view === 'daily' ? 'on' : ''}`} onClick={() => setView('daily')}>Daily Sales</button>
        <button className={`stab ${view === 'menu' ? 'on' : ''}`} onClick={() => setView('menu')}>Menu Breakdown</button>
      </div>

      {view === 'import' && (
        <div className="dlv-import-wrap">
          <div className="dlv-import-stack">

            <div className="log-card" style={{ flex: 'none' }}>
              <div className="dlv-card-head">
                <div className="dlv-card-icon"><i className="fa-solid fa-cloud-arrow-up"></i></div>
                <div>
                  <h2>Import Wongnai Delivery Report</h2>
                  <p>Upload the two Wongnai reports as <code>.xlsx</code> downloaded from the merchant portal, or convert them to <code>.csv</code> first with <code>node scripts/convert-delivery-xlsx.mjs &lt;file.xlsx&gt; out.csv</code>.</p>
                </div>
              </div>

              <div className="dlv-card-body">
                <div className="dlv-drop-grid">
                  <div>
                    <label className="flabel" style={{ display: 'block', marginBottom: 8 }}>Daily Sales Report</label>
                    <div className="dlv-dropzone" onClick={() => dailyFileRef.current?.click()}>
                      <i className="fa-solid fa-file-csv"></i>
                      <span className="fname">{dailyFileName || 'Drop file or click to browse'}</span>
                      <span className="fhint">date, sales, orders, avgBasketSize</span>
                      <span className="choose">Choose file</span>
                    </div>
                    <input ref={dailyFileRef} type="file" accept=".csv,.xlsx" onChange={(e) => onFile(e, 'daily')} style={{ display: 'none' }} />
                  </div>
                  <div>
                    <label className="flabel" style={{ display: 'block', marginBottom: 8 }}>Menu Breakdown Report</label>
                    <div className="dlv-dropzone" onClick={() => menuFileRef.current?.click()}>
                      <i className="fa-solid fa-list-ol"></i>
                      <span className="fname">{menuFileName || 'Drop file or click to browse'}</span>
                      <span className="fhint">menuName, amount, sales</span>
                      <span className="choose">Choose file</span>
                    </div>
                    <input ref={menuFileRef} type="file" accept=".csv,.xlsx" onChange={(e) => onFile(e, 'menu')} style={{ display: 'none' }} />
                  </div>
                </div>

                {(dailyRows.length > 0 || menuRows.length > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {dailyRows.length > 0 && (
                      <div className="rrow"><span className="rlbl">Daily rows</span>
                        <span className="rval strong">{dailyRows.length} days · {importPeriod.start} → {importPeriod.end} · gross {money(importGross)}</span></div>
                    )}
                    {menuRows.length > 0 && (
                      <>
                        <div className="rrow"><span className="rlbl">Menu rows</span><span className="rval">{menuRows.length} (combos expanded to {Object.keys(comp).length} drinks)</span></div>
                        <div className="rrow"><span className="rlbl">New menus to auto-create</span>
                          <span className="rval">{willCreate.length ? willCreate.join(', ') : 'none'}</span></div>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="dlv-card-foot">
                <button className="btn btn-primary" disabled={importing || (!dailyRows.length && !menuRows.length)} onClick={doImport}>
                  <i className="fa-solid fa-database"></i> {importing ? 'Importing…' : 'Import to database'}
                </button>
                <p className="helper-text">Re-importing replaces sales/menu rows. Stock is deducted only on the first import to avoid double-counting.</p>
              </div>
            </div>

            <div className="log-card" style={{ flex: 'none' }}>
              <div className="dlv-card-head">
                <div className="dlv-card-icon"><i className="fa-solid fa-tag"></i></div>
                <div>
                  <h2>Record Promotion Discount</h2>
                  <p>The Wongnai promotions report can't be exported. Open each campaign on merchant.wongnai.com/report/campaigns and enter its <strong>"ค่าส่วนลดให้ลูกค้า"</strong> (customer discount) figure here. Leave blank if a campaign had no discount.</p>
                </div>
              </div>

              <div className="dlv-card-body">
                <div className="frow2" style={{ marginBottom: 0 }}>
                  <div className="ffield">
                    <label className="flabel">Period Start</label>
                    <input type="date" className="finput" value={promoStart} onChange={(e) => setPromoStart(e.target.value)} />
                  </div>
                  <div className="ffield">
                    <label className="flabel">Period End</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input type="date" className="finput" value={promoEnd} onChange={(e) => setPromoEnd(e.target.value)} />
                      <button type="button" className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => { setPromoStart(today()); setPromoEnd(today()); }}>Today</button>
                    </div>
                  </div>
                </div>

                <div className="dlv-grid-2">
                  {PROMO_CAMPAIGNS.map(c => (
                    <div className="ffield" key={c.id}>
                      <label className="flabel">
                        {c.label} ฿
                        {promoStart && promoEnd && existingPromos[c.id] && (
                          <span style={{ color: 'var(--warning-color)' }}> (logged: {money(existingPromos[c.id].amount)})</span>
                        )}
                      </label>
                      <input
                        type="number" className="finput" placeholder="0.00"
                        value={promoAmounts[c.id] ?? ''}
                        onChange={(e) => setPromoAmounts(prev => ({ ...prev, [c.id]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>

                {promoStart && promoEnd && Object.values(existingPromos).some(Boolean) && (
                  <p className="helper-text" style={{ color: 'var(--warning-color)', marginTop: 0 }}>
                    <i className="fa-solid fa-triangle-exclamation"></i> Some campaigns for this period are already logged. Saving will replace the matching ones.
                  </p>
                )}

                <div className="dlv-total-row">
                  <div>
                    <span className="lbl">Total</span>
                    <span className="val">{money(promoTotal)}</span>
                  </div>
                  <button className="btn btn-secondary" disabled={promoSaving} onClick={submitPromo}>
                    <i className="fa-solid fa-clipboard-list"></i> {promoSaving ? 'Saving…' : 'Log as expense'}
                  </button>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}

      {view === 'daily' && (
        <div className="page-wrap">
          <div className="log-card">
            <div className="log-head"><h3>Delivery Daily Sales</h3></div>
            <div className="log-body">
              <table className="ltbl">
                <thead><tr><th>Date</th><th className="num">Gross</th><th className="num">Orders</th><th className="num">Avg Basket</th><th className="num">GP (32.1%)</th><th className="num">Net</th><th></th></tr></thead>
                <tbody>
                  {dailyLog.length ? dailyLog.map(r => (
                    <tr key={r.id}>
                      <td>{r.date}</td>
                      <td className="num"><strong>{money(r.gross_sales)}</strong></td>
                      <td className="num">{r.orders}</td>
                      <td className="num">{money(r.avg_basket)}</td>
                      <td className="num neg">−{money(r.gp_amount)}</td>
                      <td className="num">{money(r.net_sales)}</td>
                      <td><button className="btn btn-sm btn-danger" onClick={async () => { if (confirm('Delete this day?')) { await remove('deliverydaily', r.id); pushToast('Deleted.', 'success'); } }}><i className="fa-solid fa-xmark"></i></button></td>
                    </tr>
                  )) : <tr className="empty-row"><td colSpan={7}>No daily sales imported yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {view === 'menu' && (
        <div className="page-wrap">
          <div className="log-card">
            <div className="log-head"><h3>Delivery Menu Breakdown</h3></div>
            <div className="log-body">
              <table className="ltbl">
                <thead><tr><th>Menu</th><th className="num">Cups</th><th className="num">Sales</th><th>Period</th><th></th></tr></thead>
                <tbody>
                  {menuLog.length ? menuLog.map(r => (
                    <tr key={r.id}>
                      <td>{r.menu_name}</td>
                      <td className="num"><strong>{r.qty}</strong></td>
                      <td className="num">{money(r.sales)}</td>
                      <td><span className="helper-text">{r.period_start} → {r.period_end}</span></td>
                      <td><button className="btn btn-sm btn-danger" onClick={async () => { if (confirm('Delete this row?')) { await remove('deliverymenu', r.id); pushToast('Deleted.', 'success'); } }}><i className="fa-solid fa-xmark"></i></button></td>
                    </tr>
                  )) : <tr className="empty-row"><td colSpan={5}>No menu breakdown imported yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
