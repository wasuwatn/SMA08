import React, { useState, useEffect } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money, nextSeqId, computeCupCost } from '../lib/helpers.js';
import Modal from '../components/Modal.jsx';

const blankMenu = { id: '', name: '', category: '', front_price: 0, delivery_price: 0, status: 'Active' };
const blankPkg = { id: '', name: '', items: [] };
const blankMatPrep = { id: '', name: '', items: [] };
const blankAddon = { name: '', price_change: 0 };

export default function Recipes() {
  const { data, insert, update, remove, reload, pushToast } = useData();
  const [activeDrink, setActiveDrink] = useState(null);
  const [rows, setRows] = useState([]); // [{material_id, qty_used}]
  const [childRows, setChildRows] = useState([]); // [{name, material_id, qty_used}]
  const [menuModal, setMenuModal] = useState(null);
  const [pkgModal, setPkgModal] = useState(null);
  const [matPrepModal, setMatPrepModal] = useState(null);
  const [addonModal, setAddonModal] = useState(null);

  const materials = data.materials;
  const packagingbom = data.packagingbom;
  const matprepbom = data.matprepbom;

  const ingredientCategories = [...new Set(materials.map(m => m.category))];
  const allIngredientCats = [...ingredientCategories, 'Packaging Sets', 'Mat Prep Sets'];
  const catOf = (matId) => {
    if (!matId) return '';
    if (String(matId).startsWith('PBOM')) return 'Packaging Sets';
    if (String(matId).startsWith('MPREP')) return 'Mat Prep Sets';
    const m = materials.find(x => x.id === matId);
    return m ? m.category : '';
  };
  const itemsForCat = (cat) => {
    if (cat === 'Packaging Sets') return packagingbom.map(p => ({ id: p.id, label: `[Set] ${p.name}` }));
    if (cat === 'Mat Prep Sets') return matprepbom.map(p => ({ id: p.id, label: `[Prep] ${p.name}` }));
    return materials.filter(m => m.category === cat).map(m => ({ id: m.id, label: `${m.item} [${m.unit}]` }));
  };

  useEffect(() => {
    if (activeDrink) {
      setRows(data.bom.filter(b => b.menu_name === activeDrink.name).map(b => ({ material_id: b.material_id, qty_used: b.qty_used, category: catOf(b.material_id) })));
      setChildRows(data.childmenu.filter(c => c.menu_name === activeDrink.name).map(c => ({ name: c.name, category: catOf(c.material_id), material_id: c.material_id, qty_used: c.qty_used, price_change: c.price_change || 0 })));
    }
  }, [activeDrink, data.bom, data.childmenu, data.materials]);

  // ---- cost + margin -----------------------------------------------------
  const { cost, warn } = computeCupCost(rows, materials, packagingbom, matprepbom);
  const frontMargin = activeDrink && activeDrink.front_price > 0 ? ((activeDrink.front_price - cost) / activeDrink.front_price) * 100 : 0;
  const deliMargin = activeDrink && activeDrink.delivery_price > 0 ? ((activeDrink.delivery_price - cost) / activeDrink.delivery_price) * 100 : 0;

  // ---- BOM editing -------------------------------------------------------
  const addRow = () => setRows(r => [...r, { material_id: '', qty_used: 1, category: '' }]);
  const setRow = (i, k, v) => setRows(r => r.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const setRowCat = (i, cat) => setRows(r => r.map((x, idx) => idx === i ? { ...x, category: cat, material_id: '' } : x));
  const delRow = (i) => setRows(r => r.filter((_, idx) => idx !== i));

  const addChildRow = () => setChildRows(r => [...r, { name: '', category: '', material_id: '', qty_used: 1, price_change: 0 }]);
  const setChildRow = (i, k, v) => setChildRows(r => r.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  const setChildRowCat = (i, cat) => setChildRows(r => r.map((x, idx) => idx === i ? { ...x, category: cat, material_id: '' } : x));
  const delChildRow = (i) => setChildRows(r => r.filter((_, idx) => idx !== i));

  const saveRecipe = async () => {
    if (!activeDrink) return;
    const legacy = data.bom.filter(b => b.menu_name === activeDrink.name);
    for (const b of legacy) await api.remove('bom', b.id);
    for (const r of rows) {
      if (r.material_id && Number(r.qty_used) > 0) {
        await api.insert('bom', { menu_name: activeDrink.name, material_id: r.material_id, qty_used: Number(r.qty_used) });
      }
    }
    // Persist child menus (variant beans) for this drink.
    const legacyChildren = data.childmenu.filter(c => c.menu_name === activeDrink.name);
    for (const c of legacyChildren) await api.remove('childmenu', c.id);
    for (const c of childRows) {
      if (c.name && c.material_id) {
        await api.insert('childmenu', { menu_name: activeDrink.name, name: c.name.trim(), material_id: c.material_id, qty_used: Number(c.qty_used) || 1, price_change: Number(c.price_change) || 0 });
      }
    }
    await reload(['bom', 'childmenu']);
    pushToast('BOM recipe & child menus saved!', 'success');
  };

  // ---- menu (drink) modal ------------------------------------------------
  const saveMenu = async () => {
    const m = menuModal;
    if (!m.id.trim() || !m.name.trim()) return pushToast('Drink ID and name are required.', 'warning');
    const payload = { ...m, front_price: Number(m.front_price) || 0, delivery_price: Number(m.delivery_price) || 0 };
    delete payload._isNew;
    if (m._isNew) {
      if (data.menuname.some(x => x.id === m.id)) return pushToast('That drink ID already exists.', 'warning');
      await insert('menuname', payload);
    } else await update('menuname', m.id, payload);
    pushToast('Drink saved.', 'success');
    setMenuModal(null);
  };
  const delMenu = async (m) => { if (confirm(`Delete drink "${m.name}"?`)) { await remove('menuname', m.id); if (activeDrink?.id === m.id) setActiveDrink(null); pushToast('Drink deleted.', 'success'); } };

  // ---- packaging modal ---------------------------------------------------
  const savePkg = async () => {
    const p = pkgModal;
    if (!p.id.trim() || !p.name.trim()) return pushToast('Set ID and name are required.', 'warning');
    const payload = { id: p.id, name: p.name, items: JSON.stringify(p.items.filter(it => it.material_id)) };
    if (p._isNew) {
      if (data.packagingbom.some(x => x.id === p.id)) return pushToast('That set ID already exists.', 'warning');
      await insert('packagingbom', payload);
    } else await update('packagingbom', p.id, payload);
    pushToast('Packaging set saved.', 'success');
    setPkgModal(null);
  };
  const editPkg = (p) => {
    let items = [];
    try { items = JSON.parse(p.items); } catch {}
    items = items.map(it => ({ ...it, category: catOf(it.material_id) }));
    setPkgModal({ id: p.id, name: p.name, items, _isNew: false });
  };
  const delPkg = async (p) => { if (confirm(`Delete packaging set "${p.name}"?`)) { await remove('packagingbom', p.id); pushToast('Packaging set deleted.', 'success'); } };

  // ---- mat prep modal -----------------------------------------------------
  const saveMatPrep = async () => {
    const p = matPrepModal;
    if (!p.id.trim() || !p.name.trim()) return pushToast('Set ID and name are required.', 'warning');
    const payload = { id: p.id, name: p.name, items: JSON.stringify(p.items.filter(it => it.material_id)) };
    if (p._isNew) {
      if (data.matprepbom.some(x => x.id === p.id)) return pushToast('That set ID already exists.', 'warning');
      await insert('matprepbom', payload);
    } else await update('matprepbom', p.id, payload);
    pushToast('Mat prep set saved.', 'success');
    setMatPrepModal(null);
  };
  const editMatPrep = (p) => {
    let items = [];
    try { items = JSON.parse(p.items); } catch {}
    items = items.map(it => ({ ...it, category: catOf(it.material_id) }));
    setMatPrepModal({ id: p.id, name: p.name, items, _isNew: false });
  };
  const delMatPrep = async (p) => { if (confirm(`Delete mat prep set "${p.name}"?`)) { await remove('matprepbom', p.id); pushToast('Mat prep set deleted.', 'success'); } };

  // ---- addons ------------------------------------------------------------
  const saveAddon = async () => {
    const a = addonModal;
    if (!a.name.trim()) return pushToast('Add-on name required.', 'warning');
    const payload = { name: a.name.trim(), price_change: Number(a.price_change) || 0 };
    if (a._isNew) await insert('addons', payload);
    else await update('addons', a.id, payload);
    pushToast('Add-on saved.', 'success');
    setAddonModal(null);
  };
  const editAddon = (a) => setAddonModal({ id: a.id, name: a.name, price_change: a.price_change, _isNew: false });
  const delAddon = async (id) => { await remove('addons', id); pushToast('Add-on removed.', 'success'); };

  return (
    <div className="bom-grid">
      <div className="bom-top">
      {/* Top-left: drink catalog */}
      <div className="card bom-cell">
        <div className="card-header">
          <h3>Drink Menu</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setMenuModal({ ...blankMenu, id: nextSeqId('MN', data.menuname), _isNew: true })}><i className="fa-solid fa-plus"></i> Add Drink</button>
        </div>
        <div className="bom-cell-body">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Front</th><th>Delivery</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {data.menuname.length ? data.menuname.map(d => (
                  <tr key={d.id} style={{ cursor: 'pointer', background: activeDrink?.id === d.id ? 'rgba(140,179,105,.08)' : undefined }} onClick={() => setActiveDrink(d)}>
                    <td><strong>{d.name}</strong><br /><span className="helper-text">{d.category}</span></td>
                    <td>{money(d.front_price)}</td>
                    <td>{money(d.delivery_price)}</td>
                    <td><span className={`badge ${d.status === 'Active' ? 'online' : 'offline'}`}>{d.status}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm btn-secondary" onClick={() => setMenuModal({ ...d, _isNew: false })}><i className="fa-solid fa-pen-to-square"></i></button>
                      <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delMenu(d)}><i className="fa-solid fa-trash-can"></i></button>
                    </td>
                  </tr>
                )) : <tr className="empty-row"><td colSpan={5}>No drinks yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Top-right: BOM editor */}
      <div className="card bom-cell">
        <div className="card-header"><h3>{activeDrink ? `${activeDrink.name} — BOM` : 'Recipe Composer'}</h3>
          {activeDrink && <button className="btn btn-primary btn-sm" onClick={saveRecipe}><i className="fa-solid fa-floppy-disk"></i> Save Recipe</button>}
        </div>
        <div className="bom-cell-body">
          {!activeDrink ? <p className="helper-text">Select a drink on the left to edit its bill of materials.</p> : (
            <>
              <div className="grid-3 mb-12">
                <div className="stat-pill"><div className="label">Recipe Cost</div><div className="value">{money(cost)}</div></div>
                <div className="stat-pill"><div className="label">Front Margin</div><div className="value" style={{ color: frontMargin < 30 ? 'var(--warning-color)' : 'var(--success-color)' }}>{frontMargin.toFixed(1)}%</div></div>
                <div className="stat-pill"><div className="label">Delivery Margin</div><div className="value" style={{ color: deliMargin < 30 ? 'var(--warning-color)' : 'var(--accent)' }}>{deliMargin.toFixed(1)}%</div></div>
              </div>
              {warn && <div className="alert-banner"><i className="fa-solid fa-triangle-exclamation"></i> Recipe references missing or inactive ingredients.</div>}
              <table className="data">
                <thead><tr><th>Category</th><th>Ingredient</th><th>Qty</th><th></th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <select className="form-control" value={r.category} onChange={(e) => setRowCat(i, e.target.value)}>
                          <option value="">-- Category --</option>
                          {allIngredientCats.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="form-control" value={r.material_id} disabled={!r.category} onChange={(e) => setRow(i, 'material_id', e.target.value)}>
                          <option value="">{r.category ? '-- Choose Item --' : '-- Pick category first --'}</option>
                          {itemsForCat(r.category).map(it => <option key={it.id} value={it.id}>{it.label}</option>)}
                        </select>
                      </td>
                      <td><input type="number" step="any" min="0" className="form-control" style={{ width: 90 }} value={r.qty_used} onChange={(e) => setRow(i, 'qty_used', e.target.value)} /></td>
                      <td><button className="btn btn-sm btn-danger" onClick={() => delRow(i)}><i className="fa-solid fa-trash-can"></i></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn btn-secondary btn-sm mt-12" onClick={addRow}><i className="fa-solid fa-plus"></i> Add Ingredient</button>

              <div className="flex-between" style={{ marginTop: 18, marginBottom: 8 }}>
                <p className="card-title-sm" style={{ margin: 0 }}>Child Menus (customer picks one — its material is deducted)</p>
                <button className="btn btn-secondary btn-sm" onClick={addChildRow}><i className="fa-solid fa-plus"></i> Add Option</button>
              </div>
              {childRows.length === 0 ? <p className="helper-text">No options. e.g. add "Brasil Santos" → Bean material, "Ethiopia" → Bean material.</p> : (
                <table className="data">
                  <thead><tr><th>Option Name</th><th>Category</th><th>Material Deducted</th><th>Qty</th><th>Price Change</th><th></th></tr></thead>
                  <tbody>
                    {childRows.map((c, i) => (
                      <tr key={i}>
                        <td><input className="form-control" placeholder="Brasil Santos" value={c.name} onChange={(e) => setChildRow(i, 'name', e.target.value)} /></td>
                        <td>
                          <select className="form-control" value={c.category} onChange={(e) => setChildRowCat(i, e.target.value)}>
                            <option value="">-- Category --</option>
                            {allIngredientCats.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                          </select>
                        </td>
                        <td>
                          <select className="form-control" value={c.material_id} disabled={!c.category} onChange={(e) => setChildRow(i, 'material_id', e.target.value)}>
                            <option value="">{c.category ? '-- Choose Item --' : '-- Pick category first --'}</option>
                            {itemsForCat(c.category).map(it => <option key={it.id} value={it.id}>{it.label}</option>)}
                          </select>
                        </td>
                        <td><input type="number" step="any" min="0" className="form-control" style={{ width: 80 }} value={c.qty_used} onChange={(e) => setChildRow(i, 'qty_used', e.target.value)} /></td>
                        <td><input type="number" step="any" className="form-control" style={{ width: 90 }} placeholder="+฿" value={c.price_change} onChange={(e) => setChildRow(i, 'price_change', e.target.value)} /></td>
                        <td><button className="btn btn-sm btn-danger" onClick={() => delChildRow(i)}><i className="fa-solid fa-trash-can"></i></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
      </div>

      <div className="bom-bottom">
      {/* Packaging sets */}
      <div className="card bom-cell">
        <div className="card-header"><h3>Packaging Sets</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setPkgModal({ ...blankPkg, _isNew: true })}><i className="fa-solid fa-plus"></i> Add new</button>
        </div>
        <div className="bom-cell-body">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>ID</th><th>Name</th><th style={{ width: 1, textAlign: 'right' }}></th></tr></thead>
              <tbody>
                {packagingbom.length ? packagingbom.map(p => (
                  <tr key={p.id}>
                    <td><strong>{p.id}</strong></td><td>{p.name}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => editPkg(p)}><i className="fa-solid fa-pen-to-square"></i></button>
                      <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delPkg(p)}><i className="fa-solid fa-trash-can"></i></button>
                    </td>
                  </tr>
                )) : <tr className="empty-row"><td colSpan={3}>No packaging sets.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Add-ons */}
      <div className="card bom-cell">
        <div className="card-header"><h3>Add-on Options</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setAddonModal({ ...blankAddon, _isNew: true })}><i className="fa-solid fa-plus"></i> Add new</button>
        </div>
        <div className="bom-cell-body">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>ID</th><th>Name</th><th>Price Change</th><th style={{ width: 1, textAlign: 'right' }}></th></tr></thead>
              <tbody>
                {data.addons.length ? data.addons.map(a => (
                  <tr key={a.id}>
                    <td><strong>{a.id}</strong></td><td>{a.name}</td>
                    <td><span className="helper-text">+{money(a.price_change)}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => editAddon(a)}><i className="fa-solid fa-pen-to-square"></i></button>
                      <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delAddon(a.id)}><i className="fa-solid fa-trash-can"></i></button>
                    </td>
                  </tr>
                )) : <tr className="empty-row"><td colSpan={4}>No add-ons.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Mat Prep sets */}
      <div className="card bom-cell">
        <div className="card-header"><h3>Mat Prep Sets</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setMatPrepModal({ ...blankMatPrep, _isNew: true })}><i className="fa-solid fa-plus"></i> Add new</button>
        </div>
        <div className="bom-cell-body">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>ID</th><th>Name</th><th style={{ width: 1, textAlign: 'right' }}></th></tr></thead>
              <tbody>
                {matprepbom.length ? matprepbom.map(p => (
                  <tr key={p.id}>
                    <td><strong>{p.id}</strong></td><td>{p.name}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => editMatPrep(p)}><i className="fa-solid fa-pen-to-square"></i></button>
                      <button className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => delMatPrep(p)}><i className="fa-solid fa-trash-can"></i></button>
                    </td>
                  </tr>
                )) : <tr className="empty-row"><td colSpan={3}>No mat prep sets.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>

      {/* Menu modal */}
      {menuModal && (
        <Modal title={menuModal._isNew ? 'Add Drink' : `Edit ${menuModal.name}`} onClose={() => setMenuModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setMenuModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveMenu}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Drink ID {menuModal._isNew ? '(auto)' : ''}</label><input className="form-control" value={menuModal.id} disabled onChange={(e) => setMenuModal(m => ({ ...m, id: e.target.value }))} /></div>
            <div className="field"><label>Category</label><input className="form-control" value={menuModal.category} onChange={(e) => setMenuModal(m => ({ ...m, category: e.target.value }))} /></div>
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

      {/* Packaging modal */}
      {pkgModal && (
        <Modal title={pkgModal._isNew ? 'Add Packaging Set' : `Edit ${pkgModal.name}`} onClose={() => setPkgModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setPkgModal(null)}>Cancel</button><button className="btn btn-primary" onClick={savePkg}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Set ID</label><input className="form-control" value={pkgModal.id} disabled={!pkgModal._isNew} placeholder="PBOM002" onChange={(e) => setPkgModal(p => ({ ...p, id: e.target.value }))} /></div>
            <div className="field"><label>Name</label><input className="form-control" value={pkgModal.name} onChange={(e) => setPkgModal(p => ({ ...p, name: e.target.value }))} /></div>
          </div>
          <p className="card-title-sm">Components</p>
          {pkgModal.items.map((it, i) => (
            <div className="input-group mb-12" key={i}>
              <select className="form-control" value={it.category || ''} onChange={(e) => setPkgModal(p => ({ ...p, items: p.items.map((x, idx) => idx === i ? { ...x, category: e.target.value, material_id: '' } : x) }))}>
                <option value="">-- Category --</option>
                {ingredientCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="form-control" value={it.material_id} disabled={!it.category} onChange={(e) => setPkgModal(p => ({ ...p, items: p.items.map((x, idx) => idx === i ? { ...x, material_id: e.target.value } : x) }))}>
                <option value="">{it.category ? '-- Choose Item --' : '-- Pick category first --'}</option>
                {itemsForCat(it.category).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <input type="number" className="form-control" style={{ maxWidth: 90 }} value={it.qty_used} onChange={(e) => setPkgModal(p => ({ ...p, items: p.items.map((x, idx) => idx === i ? { ...x, qty_used: Number(e.target.value) } : x) }))} />
              <button className="btn btn-danger" onClick={() => setPkgModal(p => ({ ...p, items: p.items.filter((_, idx) => idx !== i) }))}><i className="fa-solid fa-trash-can"></i></button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={() => setPkgModal(p => ({ ...p, items: [...p.items, { material_id: '', qty_used: 1, category: '' }] }))}><i className="fa-solid fa-plus"></i> Add Component</button>
        </Modal>
      )}

      {/* Add-on modal */}
      {addonModal && (
        <Modal title={addonModal._isNew ? 'Add Add-on' : `Edit ${addonModal.name}`} onClose={() => setAddonModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setAddonModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveAddon}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Name</label><input className="form-control" value={addonModal.name} onChange={(e) => setAddonModal(a => ({ ...a, name: e.target.value }))} /></div>
            <div className="field"><label>Price Change</label><input type="number" className="form-control" value={addonModal.price_change} onChange={(e) => setAddonModal(a => ({ ...a, price_change: e.target.value }))} /></div>
          </div>
        </Modal>
      )}

      {/* Mat prep modal */}
      {matPrepModal && (
        <Modal title={matPrepModal._isNew ? 'Add Mat Prep Set' : `Edit ${matPrepModal.name}`} onClose={() => setMatPrepModal(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setMatPrepModal(null)}>Cancel</button><button className="btn btn-primary" onClick={saveMatPrep}>Save</button></>}>
          <div className="row-2">
            <div className="field"><label>Set ID</label><input className="form-control" value={matPrepModal.id} disabled={!matPrepModal._isNew} placeholder="MPREP001" onChange={(e) => setMatPrepModal(p => ({ ...p, id: e.target.value }))} /></div>
            <div className="field"><label>Name</label><input className="form-control" value={matPrepModal.name} onChange={(e) => setMatPrepModal(p => ({ ...p, name: e.target.value }))} /></div>
          </div>
          <p className="card-title-sm">Components</p>
          {matPrepModal.items.map((it, i) => (
            <div className="input-group mb-12" key={i}>
              <select className="form-control" value={it.category || ''} onChange={(e) => setMatPrepModal(p => ({ ...p, items: p.items.map((x, idx) => idx === i ? { ...x, category: e.target.value, material_id: '' } : x) }))}>
                <option value="">-- Category --</option>
                {ingredientCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="form-control" value={it.material_id} disabled={!it.category} onChange={(e) => setMatPrepModal(p => ({ ...p, items: p.items.map((x, idx) => idx === i ? { ...x, material_id: e.target.value } : x) }))}>
                <option value="">{it.category ? '-- Choose Item --' : '-- Pick category first --'}</option>
                {itemsForCat(it.category).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <input type="number" className="form-control" style={{ maxWidth: 90 }} value={it.qty_used} onChange={(e) => setMatPrepModal(p => ({ ...p, items: p.items.map((x, idx) => idx === i ? { ...x, qty_used: Number(e.target.value) } : x) }))} />
              <button className="btn btn-danger" onClick={() => setMatPrepModal(p => ({ ...p, items: p.items.filter((_, idx) => idx !== i) }))}><i className="fa-solid fa-trash-can"></i></button>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={() => setMatPrepModal(p => ({ ...p, items: [...p.items, { material_id: '', qty_used: 1, category: '' }] }))}><i className="fa-solid fa-plus"></i> Add Component</button>
        </Modal>
      )}
    </div>
  );
}
