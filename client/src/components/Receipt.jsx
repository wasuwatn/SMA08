import React, { useEffect } from 'react';
import { money } from '../lib/helpers.js';

// Hidden 58mm print slip. Mount it with a `data` object and it fires
// window.print() (the @media print rules in styles.css show only #print-area),
// then calls onDone so the caller can unmount it. Two kinds:
//   { kind: 'sale', orderLabel, date, cashier, customer, orderType, lines,
//     subtotal, discount, discountLabel, total, paymentMethod, received, change }
//   { kind: 'zreport', shift, totals } — the /api/shift/close response.
export default function Receipt({ data, settings, onDone }) {
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => { window.print(); if (onDone) onDone(); }, 100);
    return () => clearTimeout(t);
  }, [data]); // eslint-disable-line

  if (!data) return null;
  return (
    <div id="print-area">
      <div className="rc-center rc-bold" style={{ fontSize: 13 }}>{settings.shop_name || 'KOTEA'}</div>
      {settings.shop_address && <div className="rc-center rc-small">{settings.shop_address}</div>}
      {settings.shop_phone && <div className="rc-center rc-small">Tel. {settings.shop_phone}</div>}
      <div className="rc-hr" />
      {data.kind === 'zreport' ? <ZBody data={data} /> : <SaleBody data={data} />}
      {data.kind !== 'zreport' && settings.receipt_footer && (
        <>
          <div className="rc-hr" />
          <div className="rc-center">{settings.receipt_footer}</div>
        </>
      )}
    </div>
  );
}

function SaleBody({ data }) {
  return (
    <>
      <div className="rc-row"><span>Order</span><span>#{data.orderLabel || '—'}</span></div>
      <div className="rc-row"><span>Date</span><span>{data.date}</span></div>
      <div className="rc-row"><span>Cashier</span><span>{data.cashier}</span></div>
      {data.customer && data.customer !== 'Walk-in' && (
        <div className="rc-row"><span>Customer</span><span>{data.customer}</span></div>
      )}
      {data.orderType && <div className="rc-row"><span>Type</span><span>{data.orderType}</span></div>}
      <div className="rc-hr" />
      {data.lines.map((l, i) => (
        <div key={i}>
          <div className="rc-row">
            <span>{l.qty}× {l.name}{l.isFree ? ' (FREE)' : ''}</span>
            <span>{money(l.total)}</span>
          </div>
          {l.meta && <div className="rc-small">&nbsp;&nbsp;{l.meta}</div>}
        </div>
      ))}
      <div className="rc-hr" />
      <div className="rc-row"><span>Subtotal</span><span>{money(data.subtotal)}</span></div>
      {Number(data.discount) > 0 && (
        <div className="rc-row"><span>Discount{data.discountLabel ? ` (${data.discountLabel})` : ''}</span><span>-{money(data.discount)}</span></div>
      )}
      <div className="rc-row rc-bold" style={{ fontSize: 12 }}><span>TOTAL</span><span>{money(data.total)}</span></div>
      {data.paymentMethod && <div className="rc-row"><span>Paid by</span><span>{data.paymentMethod}</span></div>}
      {data.received != null && (
        <>
          <div className="rc-row"><span>Received</span><span>{money(data.received)}</span></div>
          <div className="rc-row"><span>Change</span><span>{money(data.change)}</span></div>
        </>
      )}
    </>
  );
}

function ZBody({ data }) {
  const s = data.shift || {};
  const t = data.totals || {};
  const fmtTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '—');
  return (
    <>
      <div className="rc-center rc-bold">— SHIFT REPORT (Z) —</div>
      <div className="rc-row"><span>Shift</span><span>#{s.id}</span></div>
      <div className="rc-row"><span>Opened</span><span>{fmtTime(s.opened_at)} ({s.opened_by})</span></div>
      <div className="rc-row"><span>Closed</span><span>{fmtTime(s.closed_at)} ({s.closed_by})</span></div>
      <div className="rc-hr" />
      <div className="rc-row"><span>Orders</span><span>{s.orders ?? 0}</span></div>
      <div className="rc-row"><span>Cups (free)</span><span>{t.cups ?? 0} ({t.free_cups ?? 0})</span></div>
      <div className="rc-row"><span>Cash sales</span><span>{money(s.cash_sales)}</span></div>
      <div className="rc-row"><span>PromptPay</span><span>{money(s.promptpay_sales)}</span></div>
      <div className="rc-row"><span>Transfer</span><span>{money(s.transfer_sales)}</span></div>
      <div className="rc-row rc-bold"><span>Total sales</span><span>{money(t.total_sales)}</span></div>
      <div className="rc-hr" />
      <div className="rc-row"><span>Opening float</span><span>{money(s.opening_cash)}</span></div>
      <div className="rc-row"><span>Expected cash</span><span>{money(s.expected_cash)}</span></div>
      {s.closing_cash != null && (
        <>
          <div className="rc-row"><span>Counted cash</span><span>{money(s.closing_cash)}</span></div>
          <div className="rc-row rc-bold"><span>Over / short</span><span>{money(s.over_short)}</span></div>
        </>
      )}
      {s.note && <div className="rc-small">Note: {s.note}</div>}
    </>
  );
}
