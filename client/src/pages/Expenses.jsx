import React, { useState } from 'react';
import { useData } from '../lib/data.jsx';
import { money, today } from '../lib/helpers.js';

const blank = () => ({
  barcode: '', date: today(), description: '', category: '', qty: 1, price: 0,
  unit: 'pcs', discount: 0, shipping: 0, note: ''
});

export default function Expenses() {
  const { data, settings, pushToast, submitExpense } = useData();
  const buyers = (settings.buyers || 'Admin, Staff, Buyer A').split(',').map(b => b.trim());
  const [f, setF] = useState(blank());
  const [buyer, setBuyer] = useState(buyers[0]);

  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const amount = Math.max(0, (Number(f.qty) || 0) * (Number(f.price) || 0) - (Number(f.discount) || 0) + (Number(f.shipping) || 0));

  const onBarcodeChange = (code) => {
    set('barcode', code);
    const trimmed = code.trim();
    if (!trimmed) return;
    const m = data.materials.find(x => x.mat_barcode === trimmed);
    if (!m) return;
    setF(p => ({ ...p, barcode: code, description: m.name || m.item, category: m.category, price: m.price, qty: 1 }));
    pushToast(`Autofilled material: ${m.item}`, 'success');
  };

  const submit = async (e) => {
    e.preventDefault();
    const expense = {
      date: f.date, description: f.description.trim(), category: f.category.trim(),
      amount, buyer, mat_barcode: f.barcode.trim(),
      qty: Number(f.qty) || 0, unit: f.unit.trim() || 'pcs', price: Number(f.price) || 0,
      discount: Number(f.discount) || 0, shipping_cost: Number(f.shipping) || 0, note: f.note.trim()
    };
    let restock = null;
    if (f.barcode.trim()) {
      const m = data.materials.find(x => x.mat_barcode === f.barcode.trim());
      if (m) restock = { material_id: m.id, increment: (Number(f.qty) || 0) * (Number(m.qty) || 1) };
    }
    const res = await submitExpense({ expense, restock });
    pushToast(res?.queued ? 'Saved offline — will sync when online.' : 'Expense logged successfully!',
      res?.queued ? 'info' : 'success');
    setF(blank());
  };

  return (
    <div className="expense-page">
      <div className="card">
        <div className="card-header"><h3>Log New Expense</h3></div>
        <form onSubmit={submit} className="expenses-form">
          <div className="field"><label>Barcode (optional)</label>
            <input className="form-control" value={f.barcode} onChange={(e) => onBarcodeChange(e.target.value)} placeholder="Scan or type barcode" />
          </div>
          <div className="row-2">
            <div className="field"><label>Date</label><input type="date" className="form-control" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
            <div className="field"><label>Category</label><input className="form-control" value={f.category} onChange={(e) => set('category', e.target.value)} /></div>
          </div>
          <div className="field"><label>Description</label><input className="form-control" value={f.description} onChange={(e) => set('description', e.target.value)} required /></div>
          <div className="row-2">
            <div className="field"><label>Quantity</label><input type="number" className="form-control" value={f.qty} onChange={(e) => set('qty', e.target.value)} /></div>
            <div className="field"><label>Unit</label><input className="form-control" value="pcs" disabled /></div>
          </div>
          <div className="row-2">
            <div className="field"><label>Unit Price ฿</label><input type="number" className="form-control" value={f.price} onChange={(e) => set('price', e.target.value)} /></div>
            <div className="field"><label>Discount ฿</label><input type="number" className="form-control" value={f.discount} onChange={(e) => set('discount', e.target.value)} /></div>
          </div>
          <div className="row-2">
            <div className="field"><label>Shipping ฿</label><input type="number" className="form-control" value={f.shipping} onChange={(e) => set('shipping', e.target.value)} /></div>
            <div className="field"><label>Buyer</label>
              <select className="form-control" value={buyer} onChange={(e) => setBuyer(e.target.value)}>{buyers.map(b => <option key={b}>{b}</option>)}</select>
            </div>
          </div>
          <div className="field"><label>Note</label><input className="form-control" value={f.note} onChange={(e) => set('note', e.target.value)} /></div>
          <div className="receipt-total mb-12"><span>Total Amount</span><span>{money(amount)}</span></div>
          <button className="btn btn-primary btn-block" type="submit"><i className="fa-solid fa-check"></i> Save Expense</button>
          <p className="helper-text">If a barcode matches a material, its warehouse stock is automatically replenished by quantity × pack size.</p>
        </form>
      </div>
    </div>
  );
}
