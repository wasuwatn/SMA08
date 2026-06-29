// Thin REST client for the KOTEA hub API.
// Mother is served by the hub (same origin → empty BASE). The POS/Expense apps
// run elsewhere and point at the hub via VITE_API_BASE (e.g. https://hub.example.com).
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
let token = '';
let onUnauthorized = () => {};

export function setApiToken(t) { token = t || ''; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && url !== '/api/auth/login') onUnauthorized();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  login: (username, password) => req('POST', '/api/auth/login', { username, password }),
  list: (table) => req('GET', `/api/${table}`),
  insert: (table, data) => req('POST', `/api/${table}`, data),
  update: (table, id, data) => req('PUT', `/api/${table}/${encodeURIComponent(id)}`, data),
  remove: (table, id) => req('DELETE', `/api/${table}/${encodeURIComponent(id)}`),
  redemption: (code) => req('GET', `/api/redemption/${encodeURIComponent(code)}`),
  checkoutPos: (payload) => req('POST', '/api/checkout/pos', payload),
  checkoutDelivery: (payload) => req('POST', '/api/checkout/delivery', payload),
  importDelivery: (payload) => req('POST', '/api/import/delivery', payload),
  expense: (payload) => req('POST', '/api/expense', payload),
  backup: () => req('GET', '/api/backup'),
  restore: (payload) => req('POST', '/api/restore', payload)
};
