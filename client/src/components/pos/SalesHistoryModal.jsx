import React from 'react';
import { money } from '../../lib/helpers.js';

// Overlay listing recent orders (grouped by order_no) with a detail panel and
// a reprint button. `orders`/`historyStats` are computed by the caller from
// its own recent-sales window — this component only renders them.
export default function SalesHistoryModal({
  onClose, historyStats, orders, selectedHistoryOrder, setSelectedHistoryOrder, onPrint
}) {
  return (
    <div className="sage-pos-history-overlay">
      <div className="sage-pos-modal-backdrop" onClick={onClose}></div>
      <div className="sage-pos-history-card">

        <div className="sage-pos-history-header">
          <div className="sage-pos-history-header-title">
            <h3>Sales history</h3>
            <p>Today · {historyStats.count} orders · {money(historyStats.total)}</p>
          </div>
          <button className="sage-pos-history-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="sage-pos-history-body">
          {/* Left Order List Panel */}
          <div className="sage-pos-history-left">
            <div className="sage-pos-history-stats">
              <div className="sage-pos-history-stat-box">
                <span className="sage-pos-history-stat-lbl">Sales</span>
                <span className="sage-pos-history-stat-val">{money(historyStats.total)}</span>
              </div>
              <div className="sage-pos-history-stat-box">
                <span className="sage-pos-history-stat-lbl">Orders</span>
                <span className="sage-pos-history-stat-val">{historyStats.count}</span>
              </div>
              <div className="sage-pos-history-stat-box">
                <span className="sage-pos-history-stat-lbl">Avg</span>
                <span className="sage-pos-history-stat-val">{money(historyStats.avg)}</span>
              </div>
            </div>

            <div className="sage-pos-history-list">
              {orders.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No sales history.</div>
              ) : (
                orders.map(order => {
                  const isActive = selectedHistoryOrder && selectedHistoryOrder.id === order.id;
                  const lineSummary = order.lines.map(l => `${l.menu_name} x${l.qty}`).join(', ');
                  return (
                    <button
                      key={order.id}
                      className={`sage-pos-history-item-btn ${isActive ? 'active' : ''}`}
                      onClick={() => setSelectedHistoryOrder(order)}
                    >
                      <div className="sage-pos-history-item-info">
                        <div className="sage-pos-history-item-row1">
                          <span className="sage-pos-history-item-txn-id">#{order.label}</span>
                          <span className="sage-pos-history-item-time">{order.date}</span>
                        </div>
                        <div className="sage-pos-history-item-cust">{order.customer_name}</div>
                        <div className="sage-pos-history-item-desc">{lineSummary}</div>
                      </div>
                      <span className="sage-pos-history-item-total">{money(order.total)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Order Details Panel */}
          <div className="sage-pos-history-right">
            {selectedHistoryOrder ? (
              <>
                <div className="sage-pos-history-detail-header">
                  <div className="sage-pos-history-detail-header-row1">
                    <h4 className="sage-pos-history-detail-title">Order #{selectedHistoryOrder.label}</h4>
                    <span className="sage-pos-history-detail-badge">
                      {selectedHistoryOrder.order_type || 'Front POS'}
                      {selectedHistoryOrder.delivery_platform ? ` · ${selectedHistoryOrder.delivery_platform}` : ''}
                    </span>
                  </div>
                  <div className="sage-pos-history-detail-meta">
                    {selectedHistoryOrder.customer_name} · {selectedHistoryOrder.date} · Cashier: {selectedHistoryOrder.cashier}
                    {selectedHistoryOrder.payment_method ? ` · Paid by ${selectedHistoryOrder.payment_method}` : ''}
                  </div>
                  {selectedHistoryOrder.customer_address && (
                    <div className="sage-pos-history-detail-meta" style={{ marginTop: 4 }}>
                      Address: {selectedHistoryOrder.customer_address}
                    </div>
                  )}
                </div>

                <div className="sage-pos-history-detail-lines">
                  {selectedHistoryOrder.lines.map((line, idx) => (
                    <div key={idx} className="sage-pos-history-detail-line">
                      <span className="sage-pos-history-detail-line-qty">{line.qty}×</span>
                      <div style={{ flex: 1 }}>
                        <div className="sage-pos-history-detail-line-name">
                          {line.menu_name}
                          {line.variant && <span style={{ color: 'var(--text-muted)' }}> · {line.variant}</span>}
                        </div>
                        <div className="sage-pos-history-detail-line-meta">
                          {line.container} / Sugar {line.sweetness}
                          {line.addons.length > 0 && ` · Add-ons: ${line.addons.join(', ')}`}
                        </div>
                      </div>
                      <span className="sage-pos-history-detail-line-price">{money(line.total_price)}</span>
                    </div>
                  ))}
                </div>

                <div className="sage-pos-history-detail-footer">
                  <div className="sage-pos-breakdown-row" style={{ fontWeight: 600, color: 'var(--olive-900)', fontSize: '14px' }}>
                    <span>Total charged</span>
                    <span className="val">{money(selectedHistoryOrder.total)}</span>
                  </div>
                  <button
                    type="button" className="sage-pos-promo-btn" style={{ marginTop: 8 }}
                    onClick={() => onPrint(selectedHistoryOrder)}
                  >
                    <i className="fa-solid fa-print"></i> Print receipt
                  </button>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                Select an order from the list to view details.
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
