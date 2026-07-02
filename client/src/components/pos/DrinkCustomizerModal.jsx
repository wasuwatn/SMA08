import React from 'react';
import { money } from '../../lib/helpers.js';

// Cart-line configurator opened from a menu card: variant, container,
// sweetness, add-ons, and (if the customer has one) a free-cup redemption.
export default function DrinkCustomizerModal({
  selected, childItems, childId, setChildId,
  container, setContainer, containers,
  sweetnessLevels, sweet, setSweet,
  addons, addonRows, toggleAddon,
  promotion, useFreeRedemption, setUseFreeRedemption, canRedeemFree, freeRemaining, eligibleForFree,
  qty, setQty, modalTotal,
  onClose, onConfirm
}) {
  return (
    <div className="sage-pos-customizer-modal">
      <div className="sage-pos-modal-backdrop" onClick={onClose}></div>
      <div className="sage-pos-modal-card">

        <div className="sage-pos-modal-header">
          <div>
            <span className="lbl">Customise</span>
            <h3 className="title">{selected.name}</h3>
          </div>
          <button className="sage-pos-modal-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Variants options (child items) */}
        {childItems.length > 0 && (
          <>
            <h4 className="sage-pos-modal-section-title">Option</h4>
            <div className="sage-pos-modal-pills">
              {childItems.map(c => (
                <button
                  key={c.id}
                  className={`sage-pos-modal-pill-btn ${String(c.id) === String(childId) ? 'active' : ''}`}
                  onClick={() => setChildId(String(c.id))}
                >
                  <span>{c.name}</span>
                  {Number(c.price_change) !== 0 && (
                    <span className="price-diff">
                      ({Number(c.price_change) > 0 ? '+' : ''}{money(c.price_change)})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Container Option */}
        <h4 className="sage-pos-modal-section-title">Container</h4>
        <div className="sage-pos-modal-pills">
          {containers.map(c => (
            <button
              key={c.value}
              className={`sage-pos-modal-pill-btn ${container === c.value ? 'active' : ''}`}
              onClick={() => setContainer(c.value)}
            >
              <span>{c.label}</span>
              {Number(c.adj) !== 0 && (
                <span className="price-diff">
                  ({Number(c.adj) > 0 ? '+' : ''}{money(c.adj)})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Sweetness Option */}
        <h4 className="sage-pos-modal-section-title">Sweetness</h4>
        <div className="sage-pos-modal-pills">
          {sweetnessLevels.map(s => (
            <button
              key={s}
              className={`sage-pos-modal-pill-btn ${sweet === s ? 'active' : ''}`}
              onClick={() => setSweet(s)}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Add-ons Option */}
        {addons.length > 0 && (
          <>
            <h4 className="sage-pos-modal-section-title">Add-ons (Max 3)</h4>
            <div className="sage-pos-modal-addons">
              {addons.map(a => {
                const isSelected = addonRows.includes(a.name);
                return (
                  <button
                    key={a.id}
                    className={`sage-pos-modal-addon-item ${isSelected ? 'active' : ''}`}
                    onClick={() => toggleAddon(a.name)}
                  >
                    <span>{a.name}</span>
                    <span className="price-diff">+{money(a.price_change)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Promotion redemption */}
        {promotion && (
          <>
            <h4 className="sage-pos-modal-section-title">Promotion</h4>
            <div className="sage-pos-modal-pills">
              <button
                type="button"
                className={`sage-pos-modal-pill-btn ${useFreeRedemption ? 'active' : ''}`}
                disabled={!canRedeemFree}
                title={
                  !eligibleForFree ? `Free redemption is limited to items ≤ ${money(promotion.max_free_value)}` :
                  freeRemaining <= 0 ? 'No free cups available for this customer' : ''
                }
                onClick={() => setUseFreeRedemption(v => {
                  const next = !v;
                  if (next) setQty(1);
                  return next;
                })}
              >
                🎁 Use free redemption{canRedeemFree ? ` (${freeRemaining} left)` : ''}
              </button>
            </div>
          </>
        )}

        {/* Quantity */}
        <div className="sage-pos-modal-qty-row">
          <span className="sage-pos-field-label" style={{ margin: 0, fontSize: '11px' }}>Quantity</span>
          <div className="sage-pos-modal-qty-controls">
            <button className="sage-pos-modal-qty-btn" disabled={useFreeRedemption} onClick={() => setQty(q => Math.max(1, q - 1))}>−</button>
            <span className="sage-pos-modal-qty-val">{qty}</span>
            <button className="sage-pos-modal-qty-btn" disabled={useFreeRedemption} onClick={() => setQty(q => q + 1)}>+</button>
          </div>
        </div>

        {/* Modal Bottom Totals & Add */}
        <div className="sage-pos-modal-footer">
          <div className="sage-pos-modal-total-box">
            <span className="sage-pos-modal-total-lbl">Total</span>
            <div className="sage-pos-modal-total-val">{money(modalTotal)}</div>
          </div>
          <button className="sage-pos-modal-confirm-btn" onClick={onConfirm}>
            Add to order
          </button>
        </div>

      </div>
    </div>
  );
}
