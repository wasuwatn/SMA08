import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { promptpayPayload } from '../../lib/promptpay.js';

// Payment method, cash tendered/change, and the PromptPay QR for the current
// cart total (regenerated whenever the QR dialog is open and the total or
// the shop's PromptPay ID changes).
export function usePosPayment(cartTotal, promptpayId) {
  const [payMethod, setPayMethod] = useState('Cash');
  const [cashReceived, setCashReceived] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');

  // Cash tendered → change due (only meaningful for cash payments).
  const received = parseFloat(cashReceived);
  const changeDue = Number.isFinite(received) ? received - cartTotal : null;

  // PromptPay QR for the current total, generated when the modal opens.
  useEffect(() => {
    if (!qrOpen) return;
    if (!promptpayId) { setQrDataUrl(''); return; }
    QRCode.toDataURL(promptpayPayload(promptpayId, cartTotal), { width: 280, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [qrOpen, cartTotal, promptpayId]);

  return {
    payMethod, setPayMethod, cashReceived, setCashReceived,
    qrOpen, setQrOpen, qrDataUrl, received, changeDue
  };
}
