// Wongnai delivery report parsing/import helpers.

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
