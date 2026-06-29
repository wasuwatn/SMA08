import React from 'react';
import { money } from '../lib/helpers.js';

export default function DrinkCustomizer({
  selected, priceField,
  childItems, childId, setChildId,
  sweetnessLevels, sweet, setSweet,
  containers, container, setContainer,
  addonRows, addons, addAddonRow, setAddon, removeAddon
}) {
  if (!selected) return (
    <div className="cust-empty">
      <div className="ico-box"><i className="fa-solid fa-mug-hot"></i></div>
      <p>Select a drink from the menu first</p>
    </div>
  );

  return (
    <>
      <div className="drink-banner">
        <span className="db-name">{selected.name}</span>
        <span className="db-price">{money(selected[priceField])}</span>
      </div>

      {childItems.length > 0 && (
        <>
          <div className="sec-lbl-row">
            <span className="sec-lbl">{selected.name} Option<span className="sec-req">*</span></span>
          </div>
          <div className="rpill-row">
            {childItems.map(c => (
              <button key={c.id} className={`rpill ${String(childId) === String(c.id) ? 'on' : ''}`} onClick={() => setChildId(c.id)}>
                {c.name}
                {Number(c.price_change) !== 0 && (
                  <span className={`delta ${Number(c.price_change) < 0 ? 'neg' : ''}`}>
                    {Number(c.price_change) > 0 ? '+' : ''}{money(c.price_change)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sec-lbl-row"><span className="sec-lbl">Sweetness</span></div>
      <div className="rpill-row">
        {sweetnessLevels.map(lvl => (
          <button key={lvl} className={`rpill ${sweet === lvl ? 'on' : ''}`} onClick={() => setSweet(lvl)}>{lvl}</button>
        ))}
      </div>

      {containers && (
        <>
          <div className="sec-lbl-row"><span className="sec-lbl">Container</span></div>
          <div className="rpill-row">
            {containers.map(c => (
              <button key={c.value} className={`rpill ${container === c.value ? 'on' : ''}`} onClick={() => setContainer(c.value)}>
                {c.label}
                {c.adj !== 0 && (
                  <span className={`delta ${c.adj < 0 ? 'neg' : ''}`}>
                    {c.adj > 0 ? '+' : ''}{money(c.adj)}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sec-lbl-row">
        <span className="sec-lbl">Add-ons (max 3)</span>
        {addonRows.length < 3 && (
          <button className="btn btn-ghost btn-sm" onClick={addAddonRow}><i className="fa-solid fa-plus"></i> Add</button>
        )}
      </div>
      {addonRows.map((val, i) => (
        <div className="addon-row" key={i}>
          <select className="finput" value={val} onChange={(e) => setAddon(i, e.target.value)}>
            <option value="">-- Choose Add-on --</option>
            {addons.map(a => <option key={a.id} value={a.name}>{a.name} (+{money(a.price_change)})</option>)}
          </select>
          <button className="btn btn-sm btn-danger" onClick={() => removeAddon(i)}><i className="fa-solid fa-xmark"></i></button>
        </div>
      ))}
    </>
  );
}
