// A claim token can arrive directly (?claim=...) or wrapped inside LIFF's
// login round-trip (?liff.state=...%3Fclaim%3D...). Stash it in
// sessionStorage BEFORE liff.login() can navigate away — sessionStorage
// survives the redirect in the same in-app-browser tab.
export const CLAIM_KEY = 'KOTEA_CLAIM';
export function stashClaimToken() {
  try {
    const qs = new URLSearchParams(window.location.search);
    let token = qs.get('claim');
    if (!token && qs.get('liff.state')) {
      const decoded = decodeURIComponent(qs.get('liff.state'));
      const query = decoded.includes('?') ? decoded.slice(decoded.indexOf('?') + 1) : decoded.replace(/^\//, '');
      token = new URLSearchParams(query).get('claim');
    }
    if (token) sessionStorage.setItem(CLAIM_KEY, token);
  } catch { /* malformed URL — nothing to claim */ }
}

// The receipt QR encodes a full liff.line.me URL (claimUrl() in
// client/src/lib/helpers.js), same shape stashClaimToken() above unwraps for
// a scanned-then-relaunched link. In-app scanning (liff.scanCodeV2) hands us
// the raw string directly instead of a relaunch, so pull the token out of it
// the same way rather than opening/redirecting anywhere.
export function extractClaimToken(raw) {
  const value = String(raw || '').trim();
  try {
    const url = new URL(value);
    const direct = url.searchParams.get('claim');
    if (direct) return direct;
    const liffState = url.searchParams.get('liff.state');
    if (liffState) {
      const decoded = decodeURIComponent(liffState);
      const query = decoded.includes('?') ? decoded.slice(decoded.indexOf('?') + 1) : decoded.replace(/^\//, '');
      const wrapped = new URLSearchParams(query).get('claim');
      if (wrapped) return wrapped;
    }
  } catch { /* not a URL — the QR held the bare code, use it as-is */ }
  return value;
}
