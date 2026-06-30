import React, { useState, useMemo } from 'react';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money, today, computeRequirements, computeCupCost, loyaltyStatus } from '../lib/helpers.js';

const CONTAINERS = [
  { value: 'Ice', label: 'Ice', adj: 0 },
  { value: 'Hot', label: 'Hot', adj: 0 },
  { value: 'Bottle', label: 'Bottle', adj: -5 }
];

export default function POS() {
  const { user, data, settings, pushToast, checkoutPos } = useData();
  const drinks = data.menuname.filter(d => d.status === 'Active');
  const categories = ['All', ...new Set(drinks.map(d => d.category))];
  const sweetnessLevels = (settings.sweetness_levels || 'No Sweet, 25%, 50%, 100%').split(',').map(s => s.trim());

  const [cat, setCat] = useState('All');

  // Cart & Order details
  const [cart, setCart] = useState([]);
  const [orderType, setOrderType] = useState('Dine-in');
  const [date, setDate] = useState(today());
  const [customer, setCustomer] = useState('');
  const [address, setAddress] = useState('');
  const [deliveryPlatform, setDeliveryPlatform] = useState('');

  // Promo code & discounts
  const [promoCode, setPromoCode] = useState('');
  const [appliedDiscount, setAppliedDiscount] = useState({ code: '', type: 'none', value: 0 });

  // LINE self-redeem code (customer minted it in the rewards portal)
  const [redeemCode, setRedeemCode] = useState('');
  const [redemption, setRedemption] = useState(null); // { id, customer_name, max_free_value }

  // Customizer modal state
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [selected, setSelected] = useState(null); // drink selected to customize
  const [qty, setQty] = useState(1);
  const [childId, setChildId] = useState('');
  const [sweet, setSweet] = useState(sweetnessLevels[0]);
  const [container, setContainer] = useState('Ice');
  const [addonRows, setAddonRows] = useState([]); // Selected addon names
  const [useFreeRedemption, setUseFreeRedemption] = useState(false);

  // Sales History overlay state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedHistoryOrder, setSelectedHistoryOrder] = useState(null);

  // Filtered drink catalog
  const shown = cat === 'All' ? drinks : drinks.filter(d => d.category === cat);

  // Customizer selections & calculations
  const childItems = selected ? data.childmenu.filter(c => c.menu_name === selected.name) : [];
  const childObj = childItems.find(c => String(c.id) === String(childId));
  const containerAdj = CONTAINERS.find(c => c.value === container)?.adj || 0;
  const addonsPrice = addonRows.reduce((s, name) => {
    const a = data.addons.find(x => x.name === name);
    return s + (a ? Number(a.price_change) : 0);
  }, 0);
  const childPriceChange = childObj ? Number(childObj.price_change) || 0 : 0;
  const base = selected ? Number(selected.front_price) : 0;
  const singleCup = base + containerAdj + addonsPrice + childPriceChange;
  const modalTotal = useFreeRedemption ? 0 : singleCup * qty;

  // Stamp-loyalty promo (buy_qty cups -> free_qty free, capped at max_free_value)
  const promotion = (data.promotions || []).find(p => p.type === 'stamp' && p.status === 'Active');
  const custRecord = useMemo(() => data.customers.find(c => c.name.trim().toLowerCase() === customer.trim().toLowerCase()), [customer, data.customers]);
  const loyalty = useMemo(() => loyaltyStatus(customer, data.salefront, promotion, custRecord?.id ?? null), [customer, data.salefront, promotion, custRecord]);
  const freeUsedInCart = cart.reduce((s, item) => s + (item.isFree ? item.qty : 0), 0);
  const freeRemaining = Math.max(0, loyalty.available - freeUsedInCart);
  const eligibleForFree = selected && promotion ? Number(selected.front_price) <= Number(promotion.max_free_value) : false;
  const canRedeemFree = !!promotion && freeRemaining > 0 && eligibleForFree;

  // Cart calculation aggregates
  const cartSubtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.totalPrice, 0);
  }, [cart]);

  const discountAmount = useMemo(() => {
    if (appliedDiscount.type === 'percent') {
      return Math.round((cartSubtotal * appliedDiscount.value) / 100);
    } else if (appliedDiscount.type === 'flat') {
      return Math.min(cartSubtotal, appliedDiscount.value);
    }
    return 0;
  }, [cartSubtotal, appliedDiscount]);

  const cartTotal = useMemo(() => {
    return cartSubtotal - discountAmount;
  }, [cartSubtotal, discountAmount]);

  // Sales history grouping: one entry per checkout (order_no), not per customer
  // name. Rows from before order_no existed each become their own single-line
  // order, since there's no reliable way to regroup them after the fact.
  const orders = useMemo(() => {
    const sorted = [...data.salefront].sort((a, b) => a.id - b.id);
    const byKey = new Map();

    for (const row of sorted) {
      const key = row.order_no || `legacy-${row.id}`;
      const addons = (() => { try { return JSON.parse(row.addons || '[]'); } catch { return []; } })();
      const lineTotal = Number(row.total_price) || 0;

      let order = byKey.get(key);
      if (!order) {
        order = {
          id: row.id,
          label: row.order_no || String(row.id).padStart(4, '0'),
          date: row.date,
          customer_name: row.customer_name || 'Walk-in',
          customer_address: row.customer_address || '',
          order_type: row.order_type || '',
          delivery_platform: row.delivery_platform || '',
          cashier: row.cashier,
          total: 0,
          lines: []
        };
        byKey.set(key, order);
      }

      const lineKey = `${row.menu_name}-${row.variant}-${row.sweetness}-${row.container}-${JSON.stringify(addons)}`;
      const existingLine = order.lines.find(l => l.key === lineKey);
      if (existingLine) {
        existingLine.qty += 1;
        existingLine.total_price += lineTotal;
      } else {
        order.lines.push({
          key: lineKey, menu_name: row.menu_name, variant: row.variant,
          sweetness: row.sweetness, container: row.container, addons,
          qty: 1, single_price: lineTotal, total_price: lineTotal
        });
      }
      order.total += lineTotal;
    }
    return [...byKey.values()].reverse();
  }, [data.salefront]);

  // Today's summary stats shown in the Sales History
  const historyStats = useMemo(() => {
    const todayOrders = orders.filter(o => o.date === today());
    const totalSales = todayOrders.reduce((sum, o) => sum + o.total, 0);
    const count = todayOrders.length;
    const avg = count > 0 ? Math.round(totalSales / count) : 0;
    return { total: totalSales, count, avg };
  }, [orders]);

  // Customer selection & Autocomplete address
  const onCustomerChange = (val) => {
    setCustomer(val);
    const c = data.customers.find(x => x.name.toLowerCase() === val.trim().toLowerCase());
    if (c) setAddress(c.address || '');
  };

  // Validate a LINE self-redeem code: pulls up the customer and lets the
  // cashier ring their free cup (the existing free-redemption toggle handles
  // the actual ฿0 cup; the code is consumed at checkout).
  const applyRedeemCode = async () => {
    const code = redeemCode.trim();
    if (!code) return;
    try {
      const r = await api.redemption(code);
      setRedemption(r);
      onCustomerChange(r.customer_name);
      pushToast(`Redeem code valid for ${r.customer_name}. Mark their free cup below.`, 'success');
    } catch (e) {
      setRedemption(null);
      pushToast(e.status === 404 ? 'Code not found, used, or expired.' : 'Could not validate code.', 'warning');
    }
  };

  // Open customizer modal on catalog card click
  const handleOpenCustomizer = (d) => {
    setSelected(d);
    const firstChild = data.childmenu.find(c => c.menu_name === d.name);
    setChildId(firstChild ? String(firstChild.id) : '');
    setSweet(sweetnessLevels[0]);
    setContainer('Ice');
    setAddonRows([]);
    setQty(1);
    setUseFreeRedemption(false);
    setCustomizerOpen(true);
  };

  // Customizer addons toggle logic
  const toggleAddon = (addonName) => {
    if (addonRows.includes(addonName)) {
      setAddonRows(prev => prev.filter(a => a !== addonName));
    } else {
      if (addonRows.length >= 3) {
        pushToast('Maximum of 3 add-ons per cup.', 'warning');
        return;
      }
      setAddonRows(prev => [...prev, addonName]);
    }
  };

  // Add configured drink from modal to Cart
  const handleAddCustomizedToCart = () => {
    const chosenAddons = [...addonRows].filter(Boolean).sort();
    const isFree = canRedeemFree && useFreeRedemption;
    const effectiveQty = isFree ? 1 : qty;
    const effectiveSingleCup = isFree ? 0 : singleCup;

    setCart(prev => {
      // Free redemptions are never merged into an existing line — each is its
      // own 1-cup line so the per-customer credit count stays exact.
      const existingIdx = !isFree ? prev.findIndex(item =>
        !item.isFree &&
        item.drink.id === selected.id &&
        item.childId === childId &&
        item.sweet === sweet &&
        item.container === container &&
        JSON.stringify(item.addonRows) === JSON.stringify(chosenAddons)
      ) : -1;

      if (existingIdx > -1) {
        const next = [...prev];
        next[existingIdx] = {
          ...next[existingIdx],
          qty: next[existingIdx].qty + effectiveQty,
          totalPrice: next[existingIdx].singleCup * (next[existingIdx].qty + effectiveQty)
        };
        return next;
      } else {
        return [...prev, {
          id: Math.random().toString(36).substring(2, 11),
          drink: selected,
          childId,
          childObj,
          sweet,
          container,
          addonRows: chosenAddons,
          addonsPrice,
          singleCup: effectiveSingleCup,
          qty: effectiveQty,
          totalPrice: effectiveSingleCup * effectiveQty,
          isFree,
          promotionId: isFree ? promotion.id : null
        }];
      }
    });

    setCustomizerOpen(false);
    setSelected(null);
    setUseFreeRedemption(false);
    pushToast(isFree ? 'Free cup added to order.' : 'Added to order.', 'success');
  };

  // Edit/Modify item quantity directly in the Cart list
  const updateCartItemQty = (id, increment) => {
    setCart(prev => prev.map(item => {
      if (item.id === id && !item.isFree) {
        const nextQty = Math.max(1, item.qty + (increment ? 1 : -1));
        return {
          ...item,
          qty: nextQty,
          totalPrice: item.singleCup * nextQty
        };
      }
      return item;
    }));
  };

  const removeCartItem = (id) => {
    setCart(prev => prev.filter(item => item.id !== id));
    pushToast('Item removed.', 'info');
  };

  // Applying promo codes
  const handleApplyPromo = () => {
    const code = promoCode.trim().toUpperCase();
    if (!code) {
      setAppliedDiscount({ code: '', type: 'none', value: 0 });
      return;
    }

    if (code === 'SAGE10' || code === 'PROMO10') {
      setAppliedDiscount({ code, type: 'percent', value: 10 });
      pushToast('10% discount code applied.', 'success');
    } else if (code === 'WELCOME') {
      setAppliedDiscount({ code, type: 'flat', value: 50 });
      pushToast('฿50 flat discount applied.', 'success');
    } else {
      const num = parseFloat(code);
      if (!isNaN(num) && num > 0) {
        setAppliedDiscount({ code: 'MANUAL', type: 'flat', value: num });
        pushToast(`฿${num} discount applied.`, 'success');
      } else {
        pushToast('Invalid promo code.', 'warning');
      }
    }
  };

  // Checkout Cart
  const checkout = async () => {
    if (cart.length === 0) return pushToast('Please add items to the cart.', 'warning');
    if (orderType === 'Delivery' && !deliveryPlatform) {
      return pushToast('Please select a delivery platform (Lineman or Grab) first.', 'warning');
    }

    // Aggregate requirements for material stock checking
    const itemsList = cart.map(item => ({
      name: item.drink.name,
      qty: item.qty,
      childId: item.childId
    }));

    const requirements = computeRequirements(
      itemsList, data.bom, data.packagingbom, data.childmenu, data.matprepbom
    );

    const reqArr = Object.entries(requirements).map(([material_id, amount]) => ({
      material_id,
      qty: amount,
      note: `Front POS: ${cart.map(item => `${item.drink.name} x${item.qty}`).join(', ')}`
    }));

    // Distribute total discount + tax proportionally into SQLite table rows
    const multiplier = cartSubtotal > 0 ? (cartTotal / cartSubtotal) : 1;
    const salesRows = [];

    for (const item of cart) {
      const adjustedPricePerCup = item.isFree ? 0 : item.singleCup * multiplier;
      for (let i = 0; i < item.qty; i++) {
        salesRows.push({
          date,
          customer_name: customer.trim() || 'Walk-in',
          customer_address: address.trim(),
          customer_id: custRecord?.id ?? null,
          order_type: orderType,
          delivery_platform: orderType === 'Delivery' ? deliveryPlatform : '',
          menu_name: item.drink.name,
          variant: item.childObj ? item.childObj.name : '',
          quantity: 1,
          sweetness: item.sweet,
          container: item.container,
          addons: JSON.stringify(item.addonRows),
          addon_price: item.addonsPrice,
          total_price: parseFloat(adjustedPricePerCup.toFixed(2)),
          cashier: user.username,
          is_free: item.isFree ? '1' : '0',
          promotion_id: item.isFree ? String(item.promotionId || '') : ''
        });
      }
    }

    // Free cups still cost real ingredients — book their BOM cost as a single
    // expense row so the giveaway shows up as a cost instead of a silent
    // margin loss (see runCheckout in server/index.js).
    const freeItems = cart.filter(item => item.isFree);
    let expense = null;
    if (freeItems.length) {
      const totalCost = freeItems.reduce((sum, item) => {
        const bomRows = data.bom.filter(b => b.menu_name === item.drink.name);
        const { cost } = computeCupCost(bomRows, data.materials, data.packagingbom, data.matprepbom);
        return sum + cost * item.qty;
      }, 0);
      expense = {
        date,
        description: `Promo giveaway: ${freeItems.map(i => `${i.drink.name} x${i.qty}`).join(', ')}`,
        amount: parseFloat(totalCost.toFixed(2)),
        buyer: user.username,
        category: 'Promotion',
        qty: freeItems.reduce((s, i) => s + i.qty, 0),
        unit: 'cup'
      };
    }

    const cupCount = salesRows.length;
    const buyer = customer.trim() || 'Walk-in';
    // Only burn the self-redeem code if a free cup is actually in this order,
    // so a mis-scan doesn't waste the customer's earned credit.
    const redemptionId = (redemption && freeItems.length) ? redemption.id : null;

    // Clear the register right away — the cashier shouldn't wait on the
    // network/DB round trip to start the next order. The actual save runs
    // in the background; any failure is surfaced via a toast afterwards.
    setCart([]);
    setCustomer('');
    setAddress('');
    setDeliveryPlatform('');
    setPromoCode('');
    setAppliedDiscount({ code: '', type: 'none', value: 0 });
    setRedeemCode('');
    setRedemption(null);
    pushToast(`Sale completed — ${cupCount} cup row(s) recorded.`, 'success');

    checkoutPos({ sales: salesRows, requirements: reqArr, date, expense, redemption_id: redemptionId })
      .then(res => {
        if (res?.queued) pushToast(`Offline — ${cupCount} cup(s) for ${buyer} queued, will sync when online.`, 'info');
      })
      .catch(e => {
        if (e.status === 409 && e.data?.material) pushToast(`Insufficient stock for ${buyer}'s order: ${e.data.material}`, 'warning');
        else if (e.status === 409) pushToast(e.data?.error || `Checkout conflict for ${buyer}'s order.`, 'warning');
        else pushToast(`Checkout failed for ${buyer}'s order — check Transaction Log.`, 'warning');
      });
  };

  const handleOpenHistory = () => {
    setHistoryOpen(true);
    if (orders.length > 0) {
      setSelectedHistoryOrder(orders[0]);
    } else {
      setSelectedHistoryOrder(null);
    }
  };

  return (
    <>
      <div className="page-area">
        <div className="sage-pos-layout">

            {/* Left Column: Menu Catalog */}
            <div className="sage-pos-menu-pane">
              <div className="sage-pos-header">
                <div className="sage-pos-header-title">
                  <h2>Menu</h2>
                  <p>Single-origin coffee · seasonal menu</p>
                </div>
                <div className="sage-pos-header-actions">
                  <button className="sage-pos-history-btn" onClick={handleOpenHistory}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9"></circle>
                      <path d="M12 7.5V12l3 1.6"></path>
                    </svg>
                    Sales history
                  </button>

                  <div className="sage-pos-segmented">
                    {['Dine-in', 'Takeaway', 'Delivery'].map(type => (
                      <button
                        key={type}
                        className={orderType === type ? 'active' : ''}
                        onClick={() => { setOrderType(type); if (type !== 'Delivery') setDeliveryPlatform(''); }}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Scrolling Category Pill Row */}
              <div className="sage-pos-cats">
                {categories.map(c => (
                  <button
                    key={c}
                    className={`sage-pos-cat-pill ${c === cat ? 'active' : ''}`}
                    onClick={() => setCat(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Product Grid */}
              <div className="sage-pos-grid-container">
                {shown.length ? (
                  <div className="sage-pos-grid">
                    {shown.map(d => (
                      <button key={d.id} className="sage-pos-card" onClick={() => handleOpenCustomizer(d)}>
                        <div className="sage-pos-card-info">
                          <span className="sage-pos-card-cat">{d.category}</span>
                          <span className="sage-pos-card-name">{d.name}</span>
                          <span className="sage-pos-card-desc">Premium brewed cafe register beverage</span>
                        </div>
                        <div className="sage-pos-card-footer">
                          <span className="sage-pos-card-price">{money(d.front_price)}</span>
                          <span className="sage-pos-card-add">+</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="sage-pos-empty">
                    <i className="fa-solid fa-mug-hot"></i>
                    <p>No active drinks found. Create one in Recipes tab.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: Order Cart Sidebar */}
            <div className="sage-pos-order-pane">
              <div className="sage-pos-order-header">
                <div className="sage-pos-order-title-row">
                  <h3 className="sage-pos-order-title">Current order</h3>
                  <span className="sage-pos-order-count">{cart.length} items</span>
                </div>

                <div className="sage-pos-order-inputs">
                  <div className="sage-pos-order-field">
                    <span className="sage-pos-field-label">Customer</span>
                    <input
                      className="sage-pos-input"
                      list="cust-list"
                      value={customer}
                      onChange={(e) => onCustomerChange(e.target.value)}
                      placeholder="Walk-in"
                    />
                    <datalist id="cust-list">
                      {data.customers.map(c => <option key={c.id} value={c.name} />)}
                    </datalist>
                  </div>

                  <div className="sage-pos-order-field date-field">
                    <span className="sage-pos-field-label">Date</span>
                    <input
                      type="date"
                      className="sage-pos-input"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>
                </div>

                <div className="sage-pos-address-row">
                  <span className="sage-pos-field-label">Address</span>
                  <input
                    className="sage-pos-input"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Street, unit, city"
                  />
                </div>

                {orderType === 'Delivery' && (
                  <div className="sage-pos-address-row">
                    <span className="sage-pos-field-label">Delivery Platform</span>
                    <div className="sage-pos-segmented">
                      {['Lineman', 'Grab'].map(p => (
                        <button
                          key={p}
                          type="button"
                          className={deliveryPlatform === p ? 'active' : ''}
                          onClick={() => setDeliveryPlatform(p)}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {promotion && customer.trim() && customer.trim() !== 'Walk-in' && (
                  <div className="sage-pos-address-row" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    🎫 Stamps: {loyalty.purchased % Number(promotion.buy_qty)}/{promotion.buy_qty}
                    {freeRemaining > 0 && (
                      <strong style={{ color: 'var(--success-color)', marginLeft: 6 }}>
                        🎁 {freeRemaining} free cup{freeRemaining > 1 ? 's' : ''} available
                      </strong>
                    )}
                  </div>
                )}

                {promotion && (
                  <div className="sage-pos-address-row">
                    <span className="sage-pos-field-label">Redeem code (LINE)</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="sage-pos-input"
                        value={redeemCode}
                        onChange={(e) => setRedeemCode(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') applyRedeemCode(); }}
                        placeholder="6-digit code"
                        inputMode="numeric"
                      />
                      <button type="button" className="sage-pos-promo-btn" onClick={applyRedeemCode} disabled={!redeemCode.trim()}>
                        Apply
                      </button>
                    </div>
                    {redemption && (
                      <span className="helper-text" style={{ color: 'var(--success-color)' }}>
                        ✓ Code for {redemption.customer_name} — mark their free cup, then charge.
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Scrollable Cart Items List */}
              <div className="sage-pos-cart-list">
                {cart.length === 0 ? (
                  <div className="sage-pos-cart-empty">
                    <i className="fa-solid fa-basket-shopping"></i>
                    Nothing here yet. Add an item from the menu.
                  </div>
                ) : (
                  cart.map(item => (
                    <div key={item.id} className="sage-pos-cart-line">
                      <div className="sage-pos-cart-item-details">
                        <div className="sage-pos-cart-item-name">
                          {item.drink.name}
                          {item.childObj && <span style={{ color: 'var(--text-muted)' }}> · {item.childObj.name}</span>}
                          {item.isFree && <span className="badge local" style={{ marginLeft: 6 }}>🎁 FREE</span>}
                        </div>
                        <div className="sage-pos-cart-item-meta">
                          {item.container} / Sugar {item.sweet}
                          {item.addonRows.length > 0 && ` · +${item.addonRows.join(', ')}`}
                        </div>
                        <div className="sage-pos-cart-qty-row">
                          <button className="sage-pos-qty-btn" disabled={item.isFree} onClick={() => updateCartItemQty(item.id, false)}>−</button>
                          <span className="sage-pos-qty-val">{item.qty}</span>
                          <button className="sage-pos-qty-btn" disabled={item.isFree} onClick={() => updateCartItemQty(item.id, true)}>+</button>
                        </div>
                      </div>

                      <div className="sage-pos-cart-item-pricing">
                        <span className="sage-pos-cart-item-price">{money(item.totalPrice)}</span>
                        <button className="sage-pos-cart-item-remove" onClick={() => removeCartItem(item.id)}>Remove</button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Breakdown Totals & checkout button */}
              <div className="sage-pos-checkout-section">
                <div className="sage-pos-promo-row">
                  <input
                    className="sage-pos-input"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    placeholder="Promo code (e.g. SAGE10)"
                  />
                  <button className="sage-pos-promo-btn" onClick={handleApplyPromo} disabled={!promoCode}>
                    Apply
                  </button>
                </div>

                <div className="sage-pos-breakdown">
                  <div className="sage-pos-breakdown-row">
                    <span>Subtotal</span>
                    <span className="val">{money(cartSubtotal)}</span>
                  </div>
                  {discountAmount > 0 && (
                    <div className="sage-pos-breakdown-row discount">
                      <span>Discount ({appliedDiscount.code})</span>
                      <span className="val">- {money(discountAmount)}</span>
                    </div>
                  )}
                  <div className="sage-pos-total-row">
                    <span className="lbl">Total</span>
                    <span className="val">{money(cartTotal)}</span>
                  </div>
                </div>

                <button
                  className="sage-pos-charge-btn"
                  onClick={checkout}
                  disabled={cart.length === 0 || (orderType === 'Delivery' && !deliveryPlatform)}
                >
                  <i className="fa-solid fa-check"></i> Charge {money(cartTotal)}
                </button>
              </div>

            </div>

          </div>
      </div>

      {/* Drink Customization Modal */}
      {customizerOpen && selected && (
        <div className="sage-pos-customizer-modal">
          <div className="sage-pos-modal-backdrop" onClick={() => setCustomizerOpen(false)}></div>
          <div className="sage-pos-modal-card">
            
            <div className="sage-pos-modal-header">
              <div>
                <span className="lbl">Customise</span>
                <h3 className="title">{selected.name}</h3>
              </div>
              <button className="sage-pos-modal-close-btn" onClick={() => setCustomizerOpen(false)}>✕</button>
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
              {CONTAINERS.map(c => (
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
            {data.addons.length > 0 && (
              <>
                <h4 className="sage-pos-modal-section-title">Add-ons (Max 3)</h4>
                <div className="sage-pos-modal-addons">
                  {data.addons.map(a => {
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
              <button className="sage-pos-modal-confirm-btn" onClick={handleAddCustomizedToCart}>
                Add to order
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Sales History Overlay Modal */}
      {historyOpen && (
        <div className="sage-pos-history-overlay">
          <div className="sage-pos-modal-backdrop" onClick={() => setHistoryOpen(false)}></div>
          <div className="sage-pos-history-card">
            
            <div className="sage-pos-history-header">
              <div className="sage-pos-history-header-title">
                <h3>Sales history</h3>
                <p>Today · {historyStats.count} orders · {money(historyStats.total)}</p>
              </div>
              <button className="sage-pos-history-close-btn" onClick={() => setHistoryOpen(false)}>✕</button>
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
      )}
    </>
  );
}
