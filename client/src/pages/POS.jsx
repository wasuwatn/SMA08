import React, { useState, useMemo, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import { useData } from '../lib/data.jsx';
import { api } from '../lib/api.js';
import { money, today, computeRequirements, computeCupCost } from '../lib/helpers.js';
import { promptpayPayload } from '../lib/promptpay.js';
import Receipt from '../components/Receipt.jsx';
import Modal from '../components/Modal.jsx';
import DrinkCustomizerModal from '../components/pos/DrinkCustomizerModal.jsx';
import SalesHistoryModal from '../components/pos/SalesHistoryModal.jsx';
import ShiftModals from '../components/pos/ShiftModals.jsx';

// How far back POS keeps its own local Sales History / shift-cash lookback.
// POS doesn't load the full salefront table (see skipHeavyTables in
// data.jsx) — a shift never runs longer than this, so it's plenty for both
// the history overlay and the close-shift cash estimate.
const HISTORY_WINDOW_DAYS = 14;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };

const PAY_METHODS = ['Cash', 'PromptPay', 'Transfer'];

const CONTAINERS = [
  { value: 'Ice', label: 'Ice', adj: 0 },
  { value: 'Hot', label: 'Hot', adj: 0 },
  { value: 'Bottle', label: 'Bottle', adj: -5 }
];

export default function POS() {
  const { user, data, settings, pushToast, checkoutPos, reload } = useData();
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

  // Customizer modal state
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const [selected, setSelected] = useState(null); // drink selected to customize
  const [qty, setQty] = useState(1);
  const [childId, setChildId] = useState('');
  const [sweet, setSweet] = useState(sweetnessLevels[0]);
  const [container, setContainer] = useState('Ice');
  const [addonRows, setAddonRows] = useState([]); // Selected addon names

  // Sales History overlay state
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedHistoryOrder, setSelectedHistoryOrder] = useState(null);

  // Payment
  const [payMethod, setPayMethod] = useState('Cash');
  const [cashReceived, setCashReceived] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');

  // Receipt printing: receiptData mounts the hidden 58mm slip and prints it;
  // lastReceipt keeps the most recent sale around for a reprint.
  const [receiptData, setReceiptData] = useState(null);
  const [lastReceipt, setLastReceipt] = useState(null);

  // Register shift
  const [shiftModal, setShiftModal] = useState(null); // 'open' | 'close' | null
  const [shiftCash, setShiftCash] = useState('');
  const [shiftNote, setShiftNote] = useState('');
  const [zReport, setZReport] = useState(null); // /api/shift/close response

  // Recent sales (last HISTORY_WINDOW_DAYS) fetched on demand — POS keeps its
  // own small window instead of the shared data.salefront cache, which the
  // satellite apps skip loading (see skipHeavyTables in data.jsx).
  const [recentSales, setRecentSales] = useState([]);
  const refreshRecentSales = useCallback(() => {
    api.list('salefront', { since: daysAgo(HISTORY_WINDOW_DAYS) }).then(setRecentSales).catch(() => {});
  }, []);
  useEffect(() => { refreshRecentSales(); }, [refreshRecentSales]);

  // Point balance for the resolved customer, looked up from the server.
  // null = unknown (no customer, or lookup failed/offline) — the Free (points)
  // button stays disabled until a real balance arrives.
  const [pointsBalance, setPointsBalance] = useState(null);

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
  const modalTotal = singleCup * qty;

  // Points promo (buy_qty = points per free cup, capped at max_free_value)
  const pointsPromo = (data.promotions || []).find(p => p.type === 'points' && p.status === 'Active');
  const pointsPerFree = pointsPromo ? Number(pointsPromo.buy_qty) || 0 : 0;
  const maxFreeValue = pointsPromo ? Number(pointsPromo.max_free_value) || 0 : 0;
  // Resolve the typed name to a customer row so sales/points key on customer_id.
  // Only registered customers can hold points, so the balance lookup keys
  // strictly on the resolved id.
  const custObj = useMemo(() => {
    const q = customer.trim().toLowerCase();
    return q ? data.customers.find(x => x.name && x.name.trim().toLowerCase() === q) : null;
  }, [customer, data.customers]);
  useEffect(() => {
    if (!custObj) { setPointsBalance(null); return; }
    setPointsBalance(null); // stale balance from the previous customer must not enable the button
    // Small debounce so typing a fresh name doesn't fire a request per keystroke.
    const t = setTimeout(() => {
      api.pointsBalance(custObj.id).then(r => setPointsBalance(Number(r.balance))).catch(() => setPointsBalance(null));
    }, 250);
    return () => clearTimeout(t);
  }, [custObj]);
  // Points already committed to free cups sitting in the cart.
  const pointsUsedInCart = cart.reduce((s, item) => s + (item.freeKind === 'points' ? pointsPerFree * item.qty : 0), 0);
  const pointsLeft = pointsBalance == null ? null : pointsBalance - pointsUsedInCart;

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

  // Cash tendered → change due (only meaningful for cash payments).
  const received = parseFloat(cashReceived);
  const changeDue = Number.isFinite(received) ? received - cartTotal : null;

  // Current register shift (one may be open at a time; cached with the rest of
  // the catalog so the indicator works offline too).
  const openShift = (data.shifts || []).find(s => s.status === 'open') || null;

  // PromptPay QR for the current total, generated when the modal opens.
  useEffect(() => {
    if (!qrOpen) return;
    if (!settings.promptpay_id) { setQrDataUrl(''); return; }
    QRCode.toDataURL(promptpayPayload(settings.promptpay_id, cartTotal), { width: 280, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [qrOpen, cartTotal, settings.promptpay_id]);

  // Sales history grouping: one entry per checkout (order_no), not per customer
  // name. Rows from before order_no existed each become their own single-line
  // order, since there's no reliable way to regroup them after the fact.
  const orders = useMemo(() => {
    const sorted = [...recentSales].sort((a, b) => a.id - b.id);
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
          payment_method: row.payment_method || '',
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
  }, [recentSales]);

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

  // Open customizer modal on catalog card click
  const handleOpenCustomizer = (d) => {
    setSelected(d);
    const firstChild = data.childmenu.find(c => c.menu_name === d.name);
    setChildId(firstChild ? String(firstChild.id) : '');
    setSweet(sweetnessLevels[0]);
    setContainer('Ice');
    setAddonRows([]);
    setQty(1);
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

  // Add configured drink from modal to Cart. Every cup enters as a paid line —
  // free-marking happens on the cart line itself (Free points / Free comp).
  const handleAddCustomizedToCart = () => {
    const chosenAddons = [...addonRows].filter(Boolean).sort();

    setCart(prev => {
      const existingIdx = prev.findIndex(item =>
        !item.isFree &&
        item.drink.id === selected.id &&
        item.childId === childId &&
        item.sweet === sweet &&
        item.container === container &&
        JSON.stringify(item.addonRows) === JSON.stringify(chosenAddons)
      );

      if (existingIdx > -1) {
        const next = [...prev];
        next[existingIdx] = {
          ...next[existingIdx],
          qty: next[existingIdx].qty + qty,
          totalPrice: next[existingIdx].singleCup * (next[existingIdx].qty + qty)
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
          singleCup,
          qty,
          totalPrice: singleCup * qty,
          isFree: false,
          freeKind: null,
          promotionId: null
        }];
      }
    });

    setCustomizerOpen(false);
    setSelected(null);
    pushToast('Added to order.', 'success');
  };

  // Mark one cup of a cart line as free. Splits a single cup off into its own
  // 1-qty ฿0 line (free lines are never merged, so the cup count stays exact).
  // kind 'points' charges the customer's balance at checkout (promotion_id set);
  // kind 'goodwill' is a staff comp — no points involved (promotion_id empty).
  const markCupFree = (id, kind) => {
    setCart(prev => {
      const idx = prev.findIndex(item => item.id === id);
      if (idx < 0) return prev;
      const item = prev[idx];
      const freeLine = {
        ...item,
        id: Math.random().toString(36).substring(2, 11),
        qty: 1,
        singleCup: 0,
        totalPrice: 0,
        paidSingleCup: item.singleCup, // kept so Undo can restore the price
        isFree: true,
        freeKind: kind,
        promotionId: kind === 'points' ? pointsPromo.id : null
      };
      const next = [...prev];
      if (item.qty > 1) {
        next[idx] = { ...item, qty: item.qty - 1, totalPrice: item.singleCup * (item.qty - 1) };
        next.splice(idx + 1, 0, freeLine);
      } else {
        next[idx] = freeLine;
      }
      return next;
    });
  };

  // Undo a free mark: the cup becomes a normal paid line again.
  const undoFreeCup = (id) => {
    setCart(prev => prev.map(item => {
      if (item.id !== id) return item;
      const price = item.paidSingleCup ?? 0;
      return {
        ...item, singleCup: price, totalPrice: price * item.qty,
        isFree: false, freeKind: null, promotionId: null, paidSingleCup: undefined
      };
    }));
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

  // ---- Register shift open / close ----------------------------------------
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

  // Reprint a past order from the Sales History overlay.
  const printHistoryOrder = (o) => setReceiptData({
    kind: 'sale', orderLabel: o.label, date: o.date, cashier: o.cashier,
    customer: o.customer_name, orderType: o.order_type,
    lines: o.lines.map(l => ({
      qty: l.qty, name: l.menu_name + (l.variant ? ` · ${l.variant}` : ''),
      meta: `${l.container} / ${l.sweetness}`, total: l.total_price
    })),
    subtotal: o.total, discount: 0, total: o.total,
    paymentMethod: o.payment_method || '', received: null, change: null
  });

  // Checkout Cart
  const checkout = async () => {
    if (cart.length === 0) return pushToast('Please add items to the cart.', 'warning');
    if (orderType === 'Delivery' && !deliveryPlatform) {
      return pushToast('Please select a delivery platform (Lineman or Grab) first.', 'warning');
    }
    if (payMethod === 'Cash' && cashReceived !== '' && changeDue < 0) {
      return pushToast('Cash received is less than the total.', 'warning');
    }
    // Point-funded free cups need the server to charge the balance — that
    // can't ride the offline queue safely, so require a connection (goodwill
    // comps queue fine).
    if (cart.some(i => i.freeKind === 'points')) {
      if (!navigator.onLine) {
        return pushToast('Free (points) cups need a connection — use Free (comp) or reconnect first.', 'warning');
      }
      if (!custObj) {
        return pushToast('Free (points) cups require a registered customer.', 'warning');
      }
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
          customer_id: custObj?.id ?? null,
          payment_method: payMethod,
          shift_id: openShift ? String(openShift.id) : '',
          customer_address: address.trim(),
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

    // Snapshot the order for the printable receipt before the register clears.
    // The order number arrives with the server response and is patched in.
    setLastReceipt({
      kind: 'sale', orderLabel: null, date, cashier: user.username,
      customer: buyer, orderType,
      lines: cart.map(i => ({
        qty: i.qty, name: i.drink.name + (i.childObj ? ` · ${i.childObj.name}` : ''),
        meta: `${i.container} / ${i.sweet}${i.addonRows.length ? ' +' + i.addonRows.join(', ') : ''}`,
        total: i.totalPrice, isFree: i.isFree
      })),
      subtotal: cartSubtotal, discount: discountAmount, discountLabel: appliedDiscount.code,
      total: cartTotal, paymentMethod: payMethod,
      received: payMethod === 'Cash' && Number.isFinite(received) ? received : null,
      change: payMethod === 'Cash' && Number.isFinite(received) ? received - cartTotal : null
    });

    // Clear the register right away — the cashier shouldn't wait on the
    // network/DB round trip to start the next order. The actual save runs
    // in the background; any failure is surfaced via a toast afterwards.
    setCart([]);
    setCustomer('');
    setAddress('');
    setDeliveryPlatform('');
    setPromoCode('');
    setAppliedDiscount({ code: '', type: 'none', value: 0 });
    setPayMethod('Cash');
    setCashReceived('');
    setQrOpen(false);
    pushToast(`Sale completed — ${cupCount} cup row(s) recorded.`, 'success');

    checkoutPos({ sales: salesRows, requirements: reqArr, date, expense })
      .then(res => {
        if (res?.queued) pushToast(`Offline — ${cupCount} cup(s) for ${buyer} queued, will sync when online.`, 'info');
        if (Array.isArray(res) && res[0]?.order_no) {
          setLastReceipt(r => (r ? { ...r, orderLabel: res[0].order_no } : r));
        }
        if (!res?.queued) refreshRecentSales(); // reflect it in Sales History / shift totals right away
      })
      .catch(e => {
        if (e.status === 409 && e.data?.material) pushToast(`Insufficient stock for ${buyer}'s order: ${e.data.material}`, 'warning');
        else if (e.status === 409) pushToast(e.data?.error || `Checkout conflict for ${buyer}'s order.`, 'warning');
        else pushToast(`Checkout failed for ${buyer}'s order — check Transaction Log.`, 'warning');
      });
  };

  const handleOpenHistory = () => {
    refreshRecentSales(); // pick up sales rung on other registers since last load
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
                  <button
                    className="sage-pos-history-btn"
                    title={openShift ? `Opened ${String(openShift.opened_at || '').replace('T', ' ').slice(0, 16)} by ${openShift.opened_by}` : 'Open a shift so sales are tied to a drawer count'}
                    onClick={() => {
                      setShiftCash(''); setShiftNote('');
                      if (openShift) refreshRecentSales(); // fresh cash estimate before closing
                      setShiftModal(openShift ? 'close' : 'open');
                    }}
                  >
                    <i className="fa-solid fa-cash-register"></i>
                    {openShift ? ` Close shift #${openShift.id}` : ' Open shift'}
                  </button>
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

                {pointsPromo && custObj && pointsBalance != null && (
                  <div className="sage-pos-address-row" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    ⭐ {pointsLeft} point{pointsLeft === 1 ? '' : 's'}
                    {pointsUsedInCart > 0 && ` (${pointsUsedInCart} in cart)`}
                    {pointsPerFree > 0 && (
                      pointsLeft >= pointsPerFree
                        ? <strong style={{ color: 'var(--success-color)', marginLeft: 6 }}>
                            🎁 free cup = {pointsPerFree} pts
                          </strong>
                        : <span style={{ marginLeft: 6 }}>— free cup = {pointsPerFree} pts</span>
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
                  cart.map(item => {
                    // A cup can be point-funded only when a registered customer is
                    // set, their (known) balance still covers one more free cup, and
                    // the cup's price fits under the promo ceiling.
                    const unitPrice = item.isFree ? (item.paidSingleCup ?? 0) : item.singleCup;
                    const canPointsFree = !item.isFree && !!pointsPromo && pointsPerFree > 0 &&
                      !!custObj && pointsLeft != null && pointsLeft >= pointsPerFree &&
                      (maxFreeValue <= 0 || unitPrice <= maxFreeValue);
                    return (
                    <div key={item.id} className="sage-pos-cart-line">
                      <div className="sage-pos-cart-item-details">
                        <div className="sage-pos-cart-item-name">
                          {item.drink.name}
                          {item.childObj && <span style={{ color: 'var(--text-muted)' }}> · {item.childObj.name}</span>}
                          {item.isFree && (
                            <span className="badge local" style={{ marginLeft: 6 }}>
                              🎁 FREE {item.freeKind === 'points' ? `(-${pointsPerFree} pts)` : '(comp)'}
                            </span>
                          )}
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
                        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                          {item.isFree ? (
                            <button type="button" className="sage-pos-cart-item-remove" onClick={() => undoFreeCup(item.id)}>
                              Undo free
                            </button>
                          ) : (
                            <>
                              <button
                                type="button" className="sage-pos-cart-item-remove"
                                disabled={!canPointsFree}
                                title={
                                  !custObj ? 'Select a registered customer first' :
                                  pointsLeft == null ? 'Point balance unavailable (offline?)' :
                                  pointsLeft < pointsPerFree ? 'Not enough points' :
                                  (maxFreeValue > 0 && unitPrice > maxFreeValue) ? `Free cups are limited to items ≤ ${money(maxFreeValue)}` : ''
                                }
                                onClick={() => markCupFree(item.id, 'points')}
                              >
                                ⭐ Free (points)
                              </button>
                              <button type="button" className="sage-pos-cart-item-remove" onClick={() => markCupFree(item.id, 'goodwill')}>
                                🎁 Free (comp)
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="sage-pos-cart-item-pricing">
                        <span className="sage-pos-cart-item-price">{money(item.totalPrice)}</span>
                        <button className="sage-pos-cart-item-remove" onClick={() => removeCartItem(item.id)}>Remove</button>
                      </div>
                    </div>
                    );
                  })
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

                {/* Payment method + cash tendered / change */}
                <div className="sage-pos-address-row">
                  <span className="sage-pos-field-label">Payment</span>
                  <div className="sage-pos-segmented">
                    {PAY_METHODS.map(m => (
                      <button key={m} type="button" className={payMethod === m ? 'active' : ''}
                        onClick={() => setPayMethod(m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                  {payMethod === 'Cash' && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                      <input
                        className="sage-pos-input"
                        type="number" min="0" step="any" inputMode="decimal"
                        value={cashReceived}
                        onChange={(e) => setCashReceived(e.target.value)}
                        placeholder="Cash received"
                      />
                      <span style={{ fontSize: 13, whiteSpace: 'nowrap', color: changeDue != null && changeDue < 0 ? 'var(--danger-color, #c0392b)' : 'var(--success-color)' }}>
                        {changeDue == null ? 'Change —' : `Change ${money(changeDue)}`}
                      </span>
                    </div>
                  )}
                  {payMethod === 'PromptPay' && (
                    <button
                      type="button" className="sage-pos-promo-btn" style={{ marginTop: 6 }}
                      disabled={cart.length === 0}
                      title={settings.promptpay_id ? '' : 'Set your PromptPay ID in Settings first'}
                      onClick={() => setQrOpen(true)}
                    >
                      <i className="fa-solid fa-qrcode"></i> Show PromptPay QR
                    </button>
                  )}
                </div>

                <button
                  className="sage-pos-charge-btn"
                  onClick={checkout}
                  disabled={cart.length === 0 || (orderType === 'Delivery' && !deliveryPlatform)}
                >
                  <i className="fa-solid fa-check"></i> Charge {money(cartTotal)}
                </button>

                {lastReceipt && (
                  <button
                    type="button" className="sage-pos-promo-btn" style={{ marginTop: 6, width: '100%' }}
                    onClick={() => setReceiptData(lastReceipt)}
                  >
                    <i className="fa-solid fa-print"></i> Print last receipt{lastReceipt.orderLabel ? ` (#${lastReceipt.orderLabel})` : ''}
                  </button>
                )}
              </div>

            </div>

          </div>
      </div>

      {/* Drink Customization Modal */}
      {customizerOpen && selected && (
        <DrinkCustomizerModal
          selected={selected} childItems={childItems} childId={childId} setChildId={setChildId}
          container={container} setContainer={setContainer} containers={CONTAINERS}
          sweetnessLevels={sweetnessLevels} sweet={sweet} setSweet={setSweet}
          addons={data.addons} addonRows={addonRows} toggleAddon={toggleAddon}
          qty={qty} setQty={setQty} modalTotal={modalTotal}
          onClose={() => setCustomizerOpen(false)} onConfirm={handleAddCustomizedToCart}
        />
      )}

      {/* Sales History Overlay Modal */}
      {historyOpen && (
        <SalesHistoryModal
          onClose={() => setHistoryOpen(false)} historyStats={historyStats} orders={orders}
          selectedHistoryOrder={selectedHistoryOrder} setSelectedHistoryOrder={setSelectedHistoryOrder}
          onPrint={printHistoryOrder}
        />
      )}

      {/* PromptPay QR — customer scans, cashier confirms transfer then charges */}
      {qrOpen && (
        <Modal title={`PromptPay · ${money(cartTotal)}`} onClose={() => setQrOpen(false)} maxWidth={360}
          footer={<button className="btn btn-primary btn-block" onClick={() => setQrOpen(false)}>Done</button>}>
          {settings.promptpay_id ? (
            qrDataUrl ? (
              <div style={{ textAlign: 'center' }}>
                <img src={qrDataUrl} alt="PromptPay QR" style={{ width: 260, maxWidth: '100%' }} />
                <p className="helper-text">Scan with any Thai banking app, then press Charge.</p>
              </div>
            ) : <p className="helper-text">Generating QR…</p>
          ) : (
            <p className="helper-text">No PromptPay ID configured. Add it in Settings → Receipt &amp; Payment.</p>
          )}
        </Modal>
      )}

      {/* Register shift: open / close / Z-report dialogs */}
      <ShiftModals
        shiftModal={shiftModal} setShiftModal={setShiftModal}
        shiftCash={shiftCash} setShiftCash={setShiftCash} shiftNote={shiftNote} setShiftNote={setShiftNote}
        doOpenShift={doOpenShift} doCloseShift={doCloseShift} openShift={openShift} shiftCashEstimate={shiftCashEstimate}
        zReport={zReport} setZReport={setZReport}
        onPrintZReport={(zr) => setReceiptData({ kind: 'zreport', ...zr })}
      />

      {/* Hidden 58mm print slip (receipt / Z-report) */}
      <Receipt data={receiptData} settings={settings} onDone={() => setReceiptData(null)} />
    </>
  );
}
