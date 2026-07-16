import React, { useState, useEffect, useCallback } from 'react';
import { lineSlipApi } from '../lib/lineSlipApi.js';
import { money } from '../lib/helpers.js';
import { loadLiff, readIdTokenParams as readParams } from '../lib/liff.js';

const FALLBACK_CATEGORIES = ['ค่าอาหาร', 'ค่าเดินทาง', 'ซื้อของเข้าร้าน', 'อื่นๆ'];

export default function ExpenseReview() {
  const [phase, setPhase] = useState('loading'); // loading | ready | done | error
  const [error, setError] = useState('');
  const [slipId, setSlipId] = useState(null);
  const [token, setToken] = useState('');
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [buyers, setBuyers] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [imageUrl, setImageUrl] = useState('');
  const [liffReady, setLiffReady] = useState(false);

  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [buyer, setBuyer] = useState('');
  const [note, setNote] = useState('');
  const [wantRestock, setWantRestock] = useState(false);
  const [restockMaterial, setRestockMaterial] = useState('');
  const [restockQty, setRestockQty] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { id, token: tok } = readParams();
    if (!id || !tok) {
      setError('ลิงก์ไม่ถูกต้อง ไม่พบรหัสอ้างอิงหรือโทเค็น');
      setPhase('error');
      return;
    }
    setSlipId(id);
    setToken(tok);
    try {
      const liffId = import.meta.env.VITE_EXPENSE_LIFF_ID;
      if (liffId) {
        try {
          const liff = await loadLiff();
          await liff.init({ liffId });
          setLiffReady(true);
        } catch {
          // Not fatal — the form still works outside LINE; only the closing
          // chat message / auto-close get skipped below.
        }
      }
      const res = await lineSlipApi.get(id, tok);
      setMerchant(res.slip.merchant || '');
      setAmount(res.slip.amount || '');
      const cats = res.categories?.length ? res.categories : FALLBACK_CATEGORIES;
      setCategories(cats);
      setCategory(res.slip.category || cats[0] || '');
      setImageUrl(res.slip.slip_image_url || '');
      setBuyers(res.buyers || []);
      setBuyer((res.buyers && res.buyers[0]) || '');
      setMaterials(res.materials || []);
      setPhase('ready');
    } catch (e) {
      setError(e.status === 404
        ? 'ไม่พบรายการนี้ หรือถูกบันทึกไปแล้ว'
        : (e.message || 'โหลดข้อมูลไม่สำเร็จ'));
      setPhase('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!merchant.trim()) { setError('กรุณากรอกชื่อร้านค้า/รายการ'); return; }
    if (!(Number(amount) > 0)) { setError('กรุณากรอกยอดเงินให้ถูกต้อง'); return; }
    setBusy(true);
    setError('');
    try {
      const restock = wantRestock && restockMaterial && Number(restockQty) > 0
        ? { material_id: restockMaterial, increment: Number(restockQty) }
        : null;
      await lineSlipApi.confirm(slipId, token, {
        merchant: merchant.trim(), amount: Number(amount), category, buyer, note: note.trim(), restock
      });
      if (liffReady && window.liff?.isInClient?.()) {
        try {
          await window.liff.sendMessages([{
            type: 'text',
            text: `✅ บันทึกรายจ่ายสำเร็จ\nร้าน: ${merchant.trim()}\nยอดเงิน: ${Number(amount).toLocaleString('th-TH')} บาท\nหมวดหมู่: ${category}`
          }]);
          window.liff.closeWindow();
          return;
        } catch {
          // Message/close failed (e.g. missing chat_message.write scope) —
          // fall through to the in-page confirmation screen instead.
        }
      }
      setPhase('done');
    } catch (e2) {
      setError(e2.status === 409
        ? 'รายการนี้ถูกบันทึกไปแล้ว'
        : (e2.message || 'บันทึกไม่สำเร็จ'));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'loading') {
    return (
      <div className="er-app" aria-busy="true" aria-label="กำลังโหลด">
        <div className="er-skel" style={{ height: 32, width: 180 }} />
        <div className="er-skel" style={{ height: 220 }} />
        <div className="er-skel" style={{ height: 320 }} />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="er-center">
        <div className="er-card er-center-card">
          <h2>เกิดข้อผิดพลาด</h2>
          <p className="er-muted" style={{ wordBreak: 'break-word' }}>{error}</p>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="er-center">
        <div className="er-card er-center-card">
          <h2>บันทึกสำเร็จ ✅</h2>
          <p>บันทึกรายจ่าย {money(Number(amount))} เรียบร้อยแล้ว</p>
          <p className="er-muted">ปิดหน้าต่างนี้ได้เลย</p>
        </div>
      </div>
    );
  }

  return (
    <div className="er-app">
      <header className="er-header">
        <h1>ตรวจสอบรายจ่าย</h1>
      </header>

      {imageUrl && (
        <div className="er-slip-preview">
          <img src={imageUrl} alt="รูปสลิป" />
        </div>
      )}

      <form className="er-card" onSubmit={submit}>
        {error && <div className="er-error-box" role="alert">{error}</div>}

        <div className="er-field">
          <label htmlFor="er-merchant">ชื่อร้านค้า / รายการ</label>
          <input id="er-merchant" className="er-input" value={merchant}
            onChange={(e) => setMerchant(e.target.value)} required />
        </div>

        <div className="er-field">
          <label htmlFor="er-amount">ยอดเงิน (บาท)</label>
          <input id="er-amount" type="number" step="0.01" inputMode="decimal" className="er-input"
            value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </div>

        <div className="er-field">
          <label htmlFor="er-category">หมวดหมู่</label>
          <select id="er-category" className="er-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {buyers.length > 0 && (
          <div className="er-field">
            <label htmlFor="er-buyer">ผู้ซื้อ</label>
            <select id="er-buyer" className="er-input" value={buyer} onChange={(e) => setBuyer(e.target.value)}>
              {buyers.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        )}

        <div className="er-field">
          <label htmlFor="er-note">หมายเหตุ (ไม่บังคับ)</label>
          <input id="er-note" className="er-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div className="er-restock">
          <label className="er-check">
            <input type="checkbox" checked={wantRestock} onChange={(e) => setWantRestock(e.target.checked)} />
            เติมสต๊อกจากบิลนี้
          </label>
          {wantRestock && (
            <div className="er-restock-row">
              <select className="er-input" value={restockMaterial} onChange={(e) => setRestockMaterial(e.target.value)}>
                <option value="">เลือกวัตถุดิบ...</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>{m.item || m.name} ({m.unit})</option>
                ))}
              </select>
              <input type="number" step="0.01" className="er-input" placeholder="จำนวน"
                value={restockQty} onChange={(e) => setRestockQty(e.target.value)} />
            </div>
          )}
        </div>

        <button className="er-submit" type="submit" disabled={busy}>
          {busy ? 'กำลังบันทึก...' : 'ยืนยันและบันทึก'}
        </button>
      </form>
    </div>
  );
}
