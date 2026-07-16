import React, { useState, useEffect, useCallback } from 'react';
import { lineChatSlipApi } from '../lib/lineSlipApi.js';
import { loadLiff, readIdTokenParams } from '../lib/liff.js';

// Checklist page for the in-chat LINE expense bot (server/lineExpense.js),
// opened via the Flex card's "แก้ไขรายการ" button (?flow=chat&id=&token=).
// Unlike the postback-per-tap toggle it replaces, unchecking an item here is
// a plain local checkbox — the server only hears about it once, on save.
export default function ChatSlipReview() {
  const [phase, setPhase] = useState('loading'); // loading | ready | done | error
  const [error, setError] = useState('');
  const [slipId, setSlipId] = useState(null);
  const [token, setToken] = useState('');
  const [merchant, setMerchant] = useState('');
  const [items, setItems] = useState([]); // [{description, amount, category, selected}]
  const [busy, setBusy] = useState(false);
  const [liffReady, setLiffReady] = useState(false);
  const [saved, setSaved] = useState(null); // { saved: [...], total } after confirm

  const load = useCallback(async () => {
    const { id, token: tok } = readIdTokenParams();
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
          // Not fatal — the checklist still works outside LINE (e.g. testing
          // the link in a desktop browser); only the closing chat message /
          // auto-close get skipped below.
        }
      }
      const res = await lineChatSlipApi.get(id, tok);
      setMerchant(res.merchant || '');
      setItems(Array.isArray(res.items) ? res.items : []);
      setPhase('ready');
    } catch (e) {
      setError(e.status === 404
        ? 'ไม่พบรายการนี้ หรือถูกบันทึกไปแล้ว'
        : (e.message || 'โหลดข้อมูลไม่สำเร็จ'));
      setPhase('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (idx) => {
    setItems((prev) => prev.map((it, i) => i === idx ? { ...it, selected: !it.selected } : it));
  };

  const selectedItems = items.filter((it) => it.selected);
  const total = selectedItems.reduce((s, it) => s + Number(it.amount || 0), 0);

  const submit = async () => {
    if (!selectedItems.length) { setError('เลือกอย่างน้อย 1 รายการก่อนบันทึก'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await lineChatSlipApi.confirm(slipId, token, items.map((it) => !!it.selected));
      if (liffReady && window.liff?.isInClient?.()) {
        try {
          const lines = res.saved.map((i) => `• ${i.description} ${i.amount} บาท (${i.category})`).join('\n');
          await window.liff.sendMessages([{
            type: 'text',
            text: `บันทึกแล้ว ${res.saved.length} รายการ ✅\n${lines}\nรวม ${res.total} บาท`
          }]);
          window.liff.closeWindow();
          return;
        } catch {
          // Message/close failed (e.g. missing chat_message.write scope) —
          // fall through to the in-page confirmation screen instead.
        }
      }
      setSaved(res);
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
          <p>บันทึก {saved?.saved?.length ?? 0} รายการ รวม {saved?.total ?? 0} บาท</p>
          <p className="er-muted">ปิดหน้าต่างนี้ได้เลย</p>
        </div>
      </div>
    );
  }

  return (
    <div className="er-app">
      <header className="er-header">
        <h1>เลือกรายการที่จะบันทึก</h1>
      </header>

      <div className="er-card">
        {error && <div className="er-error-box" role="alert">{error}</div>}
        <p style={{ fontWeight: 700 }}>{merchant || 'รายการค่าใช้จ่าย'}</p>

        <div className="er-item-list">
          {items.map((it, i) => (
            <label key={i} className="er-item-row">
              <input type="checkbox" checked={!!it.selected} onChange={() => toggle(i)} />
              <span className="er-item-desc">
                {it.description}
                <span className="er-item-cat">{it.category}</span>
              </span>
              <span className="er-item-amt">{it.amount}฿</span>
            </label>
          ))}
        </div>

        <div className="er-item-total">รวม {total} บาท ({selectedItems.length} รายการ)</div>

        <button className="er-submit" type="button" disabled={busy} onClick={submit}>
          {busy ? 'กำลังบันทึก...' : `บันทึก ${selectedItems.length} รายการ`}
        </button>
      </div>
    </div>
  );
}
