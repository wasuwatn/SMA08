// Shared by the LINE-bot LIFF pages (ExpenseReview.jsx, ChatSlipReview.jsx):
// loading the LIFF SDK on demand and reading the ?id=&token= pair that
// authenticates a single pending slip — LIFF's redirect round-trip can wrap
// the query string inside ?liff.state=... instead of passing it directly.

export function loadLiff() {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
    s.onload = () => resolve(window.liff);
    s.onerror = () => reject(new Error('Failed to load LINE SDK'));
    document.head.appendChild(s);
  });
}

// The real params, whichever form the URL arrived in (see module comment).
function resolvedParams() {
  const direct = new URLSearchParams(window.location.search);
  if (direct.get('id') || direct.get('flow')) return direct;
  const state = direct.get('liff.state');
  if (state) {
    const decoded = decodeURIComponent(state);
    const qs = decoded.includes('?') ? decoded.slice(decoded.indexOf('?') + 1) : decoded.replace(/^\//, '');
    return new URLSearchParams(qs);
  }
  return direct;
}

export function readIdTokenParams() {
  const params = resolvedParams();
  return { id: params.get('id'), token: params.get('token') || '' };
}

// Which LIFF flow to render — see expense-review-main.jsx. Reads through the
// same ?liff.state= wrapping as readIdTokenParams so a chat-flow link never
// silently falls back to the single-slip form (wrong data model entirely).
export function readFlow() {
  return resolvedParams().get('flow') || '';
}
