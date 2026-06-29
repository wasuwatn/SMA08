// Thin REST client for the customer-facing LINE portal. Mirrors lib/api.js but
// keeps its own token under a separate localStorage key so a customer session
// never collides with a staff session on the same device.
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const TOKEN_KEY = 'KOTEA_CUST_TOKEN';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); };

async function req(method, url, body, token = getToken()) {
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const customerApi = {
  // body may include { idToken } in production or { devLineUserId, devName } in dev.
  lineLogin: (body) => req('POST', '/api/customer/line-login', body),
  // Uses the short-lived pending token returned by lineLogin.
  register: (body, pendingToken) => req('POST', '/api/customer/register', body, pendingToken),
  me: () => req('GET', '/api/customer/me'),
  redeem: () => req('POST', '/api/customer/redeem', {})
};
