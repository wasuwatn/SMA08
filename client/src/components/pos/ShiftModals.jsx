import React from 'react';
import Modal from '../Modal.jsx';
import { money } from '../../lib/helpers.js';

// The three shift-lifecycle dialogs: open (set a float), close (count the
// drawer against an estimate), and the Z-report shown right after closing.
// Only one renders at a time, driven by `shiftModal` ('open' | 'close' | null)
// and `zReport` (the /api/shift/close response, or null).
export default function ShiftModals({
  shiftModal, setShiftModal, shiftCash, setShiftCash, shiftNote, setShiftNote,
  doOpenShift, doCloseShift, openShift, shiftCashEstimate,
  zReport, setZReport, onPrintZReport
}) {
  return (
    <>
      {shiftModal === 'open' && (
        <Modal title="Open shift" onClose={() => setShiftModal(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setShiftModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doOpenShift}>Open shift</button>
          </>}>
          <div className="field"><label>Opening cash float (฿)</label>
            <input className="form-control" type="number" min="0" step="any" value={shiftCash}
              onChange={(e) => setShiftCash(e.target.value)} placeholder="0" autoFocus />
          </div>
          <p className="helper-text">Count the drawer before the first sale. Every sale rung while this shift is open is included in its Z-report.</p>
        </Modal>
      )}

      {shiftModal === 'close' && openShift && (
        <Modal title={`Close shift #${openShift.id}`} onClose={() => setShiftModal(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setShiftModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doCloseShift}>Close shift</button>
          </>}>
          <p className="helper-text">
            Expected cash ≈ {money((Number(openShift.opening_cash) || 0) + shiftCashEstimate)}
            {' '}(float {money(openShift.opening_cash)} + cash sales {money(shiftCashEstimate)})
          </p>
          <div className="field"><label>Counted cash in drawer (฿)</label>
            <input className="form-control" type="number" min="0" step="any" value={shiftCash}
              onChange={(e) => setShiftCash(e.target.value)} placeholder="Leave blank to skip counting" autoFocus />
          </div>
          <div className="field"><label>Note</label>
            <input className="form-control" value={shiftNote} onChange={(e) => setShiftNote(e.target.value)} placeholder="Optional" />
          </div>
        </Modal>
      )}

      {zReport && (
        <Modal title={`Shift #${zReport.shift.id} closed — Z-report`} onClose={() => setZReport(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setZReport(null)}>Close</button>
            <button className="btn btn-primary" onClick={() => onPrintZReport(zReport)}>
              <i className="fa-solid fa-print"></i> Print
            </button>
          </>}>
          <div className="sage-pos-breakdown">
            <div className="sage-pos-breakdown-row"><span>Orders / cups</span><span className="val">{zReport.shift.orders} / {zReport.totals.cups} ({zReport.totals.free_cups} free)</span></div>
            <div className="sage-pos-breakdown-row"><span>Cash sales</span><span className="val">{money(zReport.shift.cash_sales)}</span></div>
            <div className="sage-pos-breakdown-row"><span>PromptPay</span><span className="val">{money(zReport.shift.promptpay_sales)}</span></div>
            <div className="sage-pos-breakdown-row"><span>Transfer</span><span className="val">{money(zReport.shift.transfer_sales)}</span></div>
            <div className="sage-pos-total-row"><span className="lbl">Total sales</span><span className="val">{money(zReport.totals.total_sales)}</span></div>
            <div className="sage-pos-breakdown-row"><span>Opening float</span><span className="val">{money(zReport.shift.opening_cash)}</span></div>
            <div className="sage-pos-breakdown-row"><span>Expected cash</span><span className="val">{money(zReport.shift.expected_cash)}</span></div>
            {zReport.shift.closing_cash != null && (
              <>
                <div className="sage-pos-breakdown-row"><span>Counted cash</span><span className="val">{money(zReport.shift.closing_cash)}</span></div>
                <div className="sage-pos-breakdown-row" style={{ fontWeight: 700 }}>
                  <span>Over / short</span>
                  <span className="val" style={{ color: Number(zReport.shift.over_short) < 0 ? 'var(--danger-color, #c0392b)' : 'var(--success-color)' }}>
                    {money(zReport.shift.over_short)}
                  </span>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
