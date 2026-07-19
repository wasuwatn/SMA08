import { useState, useMemo } from 'react';
import { useData } from '../../lib/data.jsx';
import { api } from '../../lib/api.js';

// Register shift: open / close with a client-side cash estimate, and the
// resulting Z-report. `openShift` and `recentSales` are owned by the caller
// (POS.jsx) since both are shared with other parts of the register.
export function useShiftRegister(openShift, recentSales) {
  const { reload, pushToast } = useData();
  const [shiftModal, setShiftModal] = useState(null); // 'open' | 'close' | null
  const [shiftCash, setShiftCash] = useState('');
  const [shiftNote, setShiftNote] = useState('');
  const [zReport, setZReport] = useState(null); // /api/shift/close response

  const doOpenShift = async () => {
    try {
      await api.shiftOpen(parseFloat(shiftCash) || 0);
      await reload(['shifts']);
      setShiftModal(null);
      pushToast('Shift opened.', 'success');
    } catch (e) {
      pushToast(e.message || 'Could not open shift.', 'warning');
    }
  };

  const doCloseShift = async () => {
    try {
      const r = await api.shiftClose(shiftCash === '' ? null : parseFloat(shiftCash), shiftNote);
      await reload(['shifts']);
      setShiftModal(null);
      setZReport(r);
    } catch (e) {
      pushToast(e.message || 'Could not close shift.', 'warning');
    }
  };

  // Client-side estimate of the open shift's cash so the close dialog can show
  // the expected drawer before the server computes the authoritative Z-report.
  const shiftCashEstimate = useMemo(() => {
    if (!openShift) return 0;
    return recentSales
      .filter(s => String(s.shift_id || '') === String(openShift.id))
      .filter(s => !s.payment_method || s.payment_method === 'Cash')
      .reduce((sum, s) => sum + (Number(s.total_price) || 0), 0);
  }, [openShift, recentSales]);

  return {
    shiftModal, setShiftModal, shiftCash, setShiftCash, shiftNote, setShiftNote,
    zReport, setZReport, doOpenShift, doCloseShift, shiftCashEstimate
  };
}
