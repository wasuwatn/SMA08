// Thin REST client for the LINE-slip expense review LIFF page. Unlike the
// staff app (JWT in localStorage) or the customer portal (its own token in
// localStorage), this page has no session at all — the per-slip
// `confirm_token` from the URL IS the auth, sent per-request instead of
// stored, so a share/forward of the link can't leak access to any other slip.
const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

async function req(method, url, body) {
  const opts = { method, headers: {} };
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

export const lineSlipApi = {
  get: (id, token) => req('GET', `/api/line/slips/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`),
  confirm: (id, token, body) => req('POST', `/api/line/slips/${encodeURIComponent(id)}/confirm`, { ...body, token })
};

// The in-chat LINE bot's checklist page (?flow=chat) — a slip analyzed into
// multiple line items, edited here with plain checkboxes instead of a
// postback-per-tap round trip through the chat.
export const lineChatSlipApi = {
  get: (id, token) => req('GET', `/api/line/chat-slips/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`),
  confirm: (id, token, selected) => req('POST', `/api/line/chat-slips/${encodeURIComponent(id)}/confirm`, { token, selected })
};
