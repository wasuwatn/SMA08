// Formatting + small general-purpose utilities.

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
