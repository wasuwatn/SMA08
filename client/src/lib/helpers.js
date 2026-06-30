// Shared formatting + small utilities.

export const TABLES = [
  'users', 'settings', 'materials', 'menuname', 'bom', 'childmenu', 'salefront', 'saledelivery',
  'stocklog', 'expenses', 'systemlog', 'customers', 'addons', 'packagingbom', 'matprepbom',
  'deliverydaily', 'deliverymenu', 'promotions'
];

// Delivery GP is computed automatically as a fixed percentage of the base price.
export const DELIVERY_GP_RATE = 0.321;

export const THEMES = [
  { id: 'kopi-green', label: 'Kopi Olive', colors: ['oklch(52% 0.062 100)', 'oklch(43% 0.052 100)', 'oklch(93.5% 0.020 100)'] },
  { id: 'kopi-terracotta', label: 'Kopi Terracotta', colors: ['oklch(53% 0.135 40)', 'oklch(43% 0.12 38)', 'oklch(95% 0.035 40)'] },
  { id: 'kopi-blue', label: 'Kopi Blue', colors: ['oklch(52% 0.13 258)', 'oklch(42% 0.12 258)', 'oklch(95% 0.025 258)'] },
  { id: 'kopi-brown', label: 'Kopi Brown', colors: ['oklch(45% 0.08 55)', 'oklch(36% 0.07 52)', 'oklch(94% 0.025 55)'] }
];

export const PAGE_SIZE = 20;

export const money = (v) =>
  `฿${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const today = () => new Date().toISOString().split('T')[0];

// Next sequential id for a prefixed series, e.g. nextSeqId('MAT', materials) -> 'MAT007'.
export function nextSeqId(prefix, rows, pad = 3) {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  rows.forEach(r => {
    const m = String(r.id ?? '').match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}${String(max + 1).padStart(pad, '0')}`;
}

export function getYearFromDate(value) {
  if (!value) return NaN;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return NaN;
  const year = parseInt(raw.slice(0, 4), 10);
  return year > 2000 && year < 2100 ? year : NaN;
}

// Parse a discount token like "10%" (percentage of base) or "15" (flat amount).
export function parseDiscount(token, base) {
  const t = token == null ? '' : String(token).trim();
  if (!t) return 0;
  if (t.endsWith('%')) {
    const pct = parseFloat(t.slice(0, -1)) || 0;
    return base * (pct / 100);
  }
  const flat = parseFloat(t);
  return isNaN(flat) ? 0 : flat;
}

// Count cups inside a delivery raw_order_string e.g. "Espresso (3), Latte (2)".
export function parseOrderCups(raw) {
  const map = {};
  if (!raw) return map;
  raw.split(',').forEach(item => {
    const m = item.trim().match(/^(.*?)\s*\((\d+)\)$/);
    if (m) map[m[1]] = (map[m[1]] || 0) + parseInt(m[2], 10);
  });
  return map;
}

// Normalize Wongnai delivery report header names so CSV/TSV/XLSX exports with
// different casing (or the "time" column) line up with the fields the app
// expects: date, sales, orders, avgBasketSize, menuName, amount.
export const DELIVERY_HEADER_ALIASES = {
  time: 'date', date: 'date', sales: 'sales', orders: 'orders',
  avgbasketsize: 'avgBasketSize', menuname: 'menuName', amount: 'amount'
};

// Split a Wongnai menu line into its component drink names.
//  - Strips a leading bracket tag, e.g. "[เซตสุดฮิต] A + B" -> "A + B".
//  - A combo joined by "+" becomes multiple drinks (1 combo = 1 of each).
//  - Single items (incl. names using "x" like "Matcha x Yuzu") are returned as-is.
export function splitComboName(name) {
  const s = String(name || '').trim().replace(/^\s*\[[^\]]*\]\s*/, '');
  if (s.includes('+')) return s.split('+').map(x => x.trim()).filter(Boolean);
  return s ? [s] : [];
}

// Flatten delivery menu rows into { drinkName: totalCups }, expanding combos.
// Accepts rows shaped like the CSV ({ menuName, amount }) or the DB
// ({ menu_name, qty }).
export function decomposeDeliveryMenu(rows) {
  const map = {};
  (rows || []).forEach(r => {
    const qty = Number(r.qty ?? r.amount) || 0;
    splitComboName(r.menu_name ?? r.menuName).forEach(n => { map[n] = (map[n] || 0) + qty; });
  });
  return map;
}

// Expand a PBOM/MPREP set id into its component [{material_id, qty_used}] items.
// Returns null if the id is not a set prefix (caller should treat it as a plain material).
export function expandSetItems(materialId, packagingbom, matprepbom) {
  const id = String(materialId);
  const pool = id.startsWith('PBOM') ? packagingbom : id.startsWith('MPREP') ? matprepbom : null;
  if (!pool) return null;
  const set = pool.find(p => p.id === materialId);
  if (!set) return [];
  try { return JSON.parse(set.items); } catch { return []; }
}

// Aggregate raw-material requirements for drink lines.
// Each line: { name, qty, childId? }.
//  - Base BOM rows for the drink are always deducted (packaging "PBOM" sets and
//    mat prep "MPREP" sets are expanded into their component materials).
//  - If the line has a childId, the selected child menu's material (e.g. the bean
//    the customer picked) is deducted too.
export function computeRequirements(lines, bom, packagingbom = [], childmenu = [], matprepbom = []) {
  const req = {};
  const add = (matId, amount) => { if (matId) req[matId] = (req[matId] || 0) + amount; };
  lines.forEach(({ name, qty, childId }) => {
    bom.filter(b => b.menu_name === name).forEach(r => {
      const amount = Number(r.qty_used) * qty;
      const setItems = expandSetItems(r.material_id, packagingbom, matprepbom);
      if (setItems !== null) {
        setItems.forEach(it => add(it.material_id, Number(it.qty_used) * amount));
      } else {
        add(r.material_id, amount);
      }
    });
    if (childId) {
      const child = childmenu.find(c => String(c.id) === String(childId));
      if (child) add(child.material_id, Number(child.qty_used || 1) * qty);
    }
  });
  return req;
}

// BOM cost of one cup given its `[{material_id, qty_used}]` rows (sum of
// material.unit_price * qty_used, expanding PBOM/MPREP sets). Returns
// { cost, warn } — warn flags missing or inactive materials. Pass
// bom.filter(b => b.menu_name === name) for a saved menu's full recipe.
export function computeCupCost(bomRows, materials, packagingbom = [], matprepbom = []) {
  let cost = 0, warn = false;
  bomRows.forEach(r => {
    if (!r.material_id) return;
    const q = Number(r.qty_used) || 0;
    const setItems = expandSetItems(r.material_id, packagingbom, matprepbom);
    if (setItems !== null) {
      setItems.forEach(it => {
        const sm = materials.find(m => m.id === it.material_id);
        if (sm) { cost += Number(sm.unit_price) * Number(it.qty_used) * q; if (sm.status !== 'Active') warn = true; }
        else warn = true;
      });
      if (!setItems.length) warn = true;
    } else {
      const m = materials.find(x => x.id === r.material_id);
      if (m) { cost += Number(m.unit_price) * q; if (m.status !== 'Active') warn = true; }
      else warn = true;
    }
  });
  return { cost, warn };
}

// Stamp-loyalty status for a named customer: how many paid cups they've
// bought, how many free cups they've already received, and how many free
// cups they're eligible for right now. Walk-ins (no name) never accumulate.
export function loyaltyStatus(customerName, salefront, promotion) {
  if (!customerName || customerName === 'Walk-in' || !promotion) {
    return { purchased: 0, given: 0, available: 0 };
  }
  const nl = customerName.trim().toLowerCase();
  const mine = salefront.filter(s => s.customer_name && s.customer_name.trim().toLowerCase() === nl);
  const purchased = mine.filter(s => s.is_free !== '1').length;
  const given = mine.filter(s => s.is_free === '1').length;
  const buyQty = Number(promotion.buy_qty) || 1;
  const available = Math.max(0, Math.floor(purchased / buyQty) - given);
  return { purchased, given, available };
}

export function csvEscape(val) {
  const s = val === null || val === undefined ? '' : String(val);
  return `"${s.replace(/"/g, '""')}"`;
}

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function parseCSVLine(text, delim = ',') {
  const result = [];
  let inQuote = false, entry = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === delim && !inQuote) { result.push(entry); entry = ''; }
    else entry += ch;
  }
  result.push(entry);
  return result.map(v => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
}
