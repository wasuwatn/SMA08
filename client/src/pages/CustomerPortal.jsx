import React, { useState, useEffect, useCallback, useRef } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { customerApi, setToken } from '../lib/customerApi.js';
import { money } from '../lib/helpers.js';

// Load the official LIFF SDK from LINE's CDN on demand (no bundled dependency).
function loadLiff() {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
    s.onload = () => resolve(window.liff);
    s.onerror = () => reject(new Error('Failed to load LINE SDK'));
    document.head.appendChild(s);
  });
}

/* ---- SVG icons — hand-drawn line-art family -------------------------------- */
// Earned stamp: line-art bubble-tea cup with pearls, drawn inside the scallop
// seal so a collected stamp reads at a glance (empty slots stay blank).
const CupArt = () => (
  <svg className="cp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 8.5h11l-1.3 11a1.5 1.5 0 0 1-1.5 1.3H9.3a1.5 1.5 0 0 1-1.5-1.3l-1.3-11Z" />
    <path d="M10 8.5 12.8 3l2.7 1" />
    <circle cx="10" cy="16.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="14" cy="16.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="13.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);
// Zig-zag seal edge for stamp slots — 24 teeth around a 64px viewBox.
const SCALLOP_POINTS = Array.from({ length: 48 }, (_, i) => {
  const a = (Math.PI * i) / 24;
  const r = i % 2 === 0 ? 29 : 25.5;
  return `${(32 + r * Math.cos(a)).toFixed(2)},${(32 + r * Math.sin(a)).toFixed(2)}`;
}).join(' ');
const Scallop = ({ earned }) => (
  <svg className="cp-scallop" viewBox="0 0 64 64" aria-hidden="true">
    <polygon points={SCALLOP_POINTS} fill={earned ? 'rgba(61, 63, 33, 0.14)' : 'none'}
      stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
);
const Sparkle = ({ className }) => (
  <svg className={`cp-deco ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M12 2.5v19M3.8 7.3l16.4 9.4M3.8 16.7l16.4-9.4" />
  </svg>
);
const GiftIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    <path d="M7.5 8a2.4 2.4 0 0 1 0-4.8C10 3.2 12 8 12 8s2-4.8 4.5-4.8a2.4 2.4 0 0 1 0 4.8" />
  </svg>
);
const TicketIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6Z" />
    <path d="M13 5v2m0 10v2m0-8v2" />
  </svg>
);
const ReceiptIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z" />
    <path d="M9 7h6M9 11h6" />
  </svg>
);
const StarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8L12 3Z" />
  </svg>
);
const GalleryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 5-5 4 4 3-3 4 4" />
  </svg>
);

const COUPON_LABEL = { pending: 'รอใช้งาน', used: 'ใช้แล้ว', expired: 'หมดอายุ' };
const POINTS_LABEL = { link: 'รับแต้มจากร้าน', crm: 'รับแต้มจากร้าน', spend: 'แลกแก้วฟรี' };

const fmtDate = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
};
const fmtDateTime = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// A claim token can arrive directly (?claim=...) or wrapped inside LIFF's
// login round-trip (?liff.state=...%3Fclaim%3D...). Stash it in
// sessionStorage BEFORE liff.login() can navigate away — sessionStorage
// survives the redirect in the same in-app-browser tab.
const CLAIM_KEY = 'KOTEA_CLAIM';
function stashClaimToken() {
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
function extractClaimToken(raw) {
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

export default function CustomerPortal() {
  const [phase, setPhase] = useState('loading'); // loading | register | ready | error
  const [error, setError] = useState('');
  const [data, setData] = useState(null);        // { customer, pointsBalance, pointsPerFree, maxFreeValue, pointsAvailable, pointsPending, pointsHistory, coupons, recentOrders, shopName }
  const [pendingToken, setPendingToken] = useState('');
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regGender, setRegGender] = useState('NA');
  const [regDob, setRegDob] = useState('');
  const [busy, setBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState(null); // { type: 'success'|'error', text }
  const [claimCodeInput, setClaimCodeInput] = useState('');
  const [claimBusy, setClaimBusy] = useState(false); // separate from `busy` (redeem/register) so the two forms don't disable each other
  const [scanBusy, setScanBusy] = useState(false); // decoding a picked receipt photo
  const fileInputRef = useRef(null);
  const [redeem, setRedeem] = useState(null);    // { code, expires_at, max_free_value }
  const [qrUrl, setQrUrl] = useState('');
  const [tab, setTab] = useState('orders');      // orders | coupons | points

  const loadMe = useCallback(async () => {
    const me = await customerApi.me();
    setData(me);
    setPhase('ready');
  }, []);

  const bootstrap = useCallback(async () => {
    // First thing, before any LIFF init/login can redirect this page away.
    stashClaimToken();
    try {
      const liffId = import.meta.env.VITE_LIFF_ID;
      const devUser = import.meta.env.VITE_DEV_LINE_USER; // local testing only
      let loginBody;
      let liff;
      if (liffId) {
        try {
          liff = await loadLiff();
        } catch {
          setError('ไม่สามารถโหลด LINE SDK ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต');
          setPhase('error');
          return;
        }
        try {
          await liff.init({ liffId });
        } catch (e) {
          setError(`LIFF init ล้มเหลว: ${e.message || 'กรุณาตรวจสอบว่า LIFF ID ถูกต้องและโดเมนนี้ได้รับอนุญาตใน LINE Developers Console'}`);
          setPhase('error');
          return;
        }
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
        loginBody = { idToken: liff.getIDToken() };
      } else if (devUser) {
        loginBody = { devLineUserId: devUser, devName: 'Dev Tester' };
      } else {
        setError('ยังไม่ได้ตั้งค่า VITE_LIFF_ID — กรุณาเปิดหน้านี้ผ่าน LINE');
        setPhase('error');
        return;
      }
      let res;
      try {
        res = await customerApi.lineLogin(loginBody);
      } catch (e) {
        // The LIFF session can stay "logged in" long after its cached ID
        // token itself expires, so a plain retry would just resubmit the
        // same stale token forever. Force a fresh LINE login instead.
        if (liffId && /expired/i.test(e.message || '')) {
          try { liff.logout(); } catch { /* no-op */ }
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const hint = e.message === 'Failed to fetch'
          ? 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาตรวจสอบว่า VITE_API_BASE ชี้ไปยัง API server ที่ถูกต้อง'
          : e.message;
        setError(hint || 'เข้าสู่ระบบไม่สำเร็จ');
        setPhase('error');
        return;
      }
      if (res.needsRegistration) {
        setPendingToken(res.token);
        setRegName(res.name || '');
        setPhase('register');
      } else {
        setToken(res.token);
        await loadMe();
      }
    } catch (e) {
      setError(e.message || 'Something went wrong.');
      setPhase('error');
    }
  }, [loadMe]);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  const submitRegister = async (e) => {
    e.preventDefault();
    if (!regPhone.trim()) { setError('กรุณากรอกเบอร์โทร'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await customerApi.register({
        phone: regPhone.trim(), gender: regGender,
        date_of_birth: regDob || null
      }, pendingToken);
      setToken(res.token);
      await loadMe();
    } catch (e2) {
      setError(e2.message || 'ลงทะเบียนไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  // Claim any stashed point link once a session is live. Runs on 'ready' so it
  // also fires after a brand-new customer finishes registration. The server
  // answers a same-customer retry idempotently, so accidental re-fires are safe.
  useEffect(() => {
    if (phase !== 'ready') return;
    const token = sessionStorage.getItem(CLAIM_KEY);
    if (!token) return;
    sessionStorage.removeItem(CLAIM_KEY);
    (async () => {
      try {
        const r = await customerApi.claimPoints(token);
        setClaimMsg({
          type: 'success',
          text: r.alreadyClaimed ? `ลิงค์นี้รับไปแล้ว (+${r.points} แต้ม)` : `รับ ${r.points} แต้มเรียบร้อย! 🎉`
        });
        await loadMe();
      } catch (e) {
        setClaimMsg({
          type: 'error',
          text: e.status === 404 ? 'ไม่พบลิงค์รับแต้มนี้'
            : e.status === 409 ? 'ลิงค์นี้ถูกใช้ไปแล้วโดยลูกค้าท่านอื่น'
            : (e.message || 'รับแต้มไม่สำเร็จ กรุณาลองใหม่')
        });
      }
    })();
  }, [phase, loadMe]);

  const doRedeem = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await customerApi.redeem();
      setRedeem(r);
      setQrUrl(await QRCode.toDataURL(r.code, { width: 440, margin: 1 }));
      await loadMe(); // refresh available/pending counts
    } catch (e) {
      setError(e.message || 'แลกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const closeRedeem = () => { setRedeem(null); setQrUrl(''); };

  // Shared by manual code entry and QR scanning below — same endpoint as the
  // shop-issued link claim above, the server tells the two apart by `kind`.
  const doClaim = async (code) => {
    if (!code) return;
    setClaimBusy(true);
    setClaimMsg(null);
    try {
      const r = await customerApi.claimPoints(code);
      setClaimMsg({
        type: 'success',
        text: r.alreadyClaimed ? `รหัสนี้รับไปแล้ว (+${r.points} แต้ม)` : `รับ ${r.points} แต้มเรียบร้อย! 🎉`
      });
      setClaimCodeInput('');
      await loadMe();
    } catch (e2) {
      setClaimMsg({
        type: 'error',
        text: e2.status === 404 ? 'ไม่พบรหัสนี้ กรุณาตรวจสอบอีกครั้ง'
          : e2.status === 409 ? 'รหัสนี้ถูกใช้ไปแล้ว'
          : (e2.message || 'รับแต้มไม่สำเร็จ กรุณาลองใหม่')
      });
    } finally {
      setClaimBusy(false);
    }
  };

  // Manual entry of a receipt claim code. Normalizes case client-side since
  // the printed code is uppercase.
  const submitClaimCode = async (e) => {
    e.preventDefault();
    await doClaim(claimCodeInput.trim().toUpperCase());
  };

  // Decode a QR straight out of an image file (a saved photo/screenshot of
  // the receipt) instead of a live camera scan — works in any browser, not
  // just inside LINE's in-app WebView, and doesn't depend on LIFF's native
  // scanner APIs at all.
  const decodeQrFromFile = (file) => new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      // Cap the decode canvas so a full-resolution phone photo doesn't choke
      // the browser — a receipt's QR block is a small fraction of the frame,
      // so downscaling the long edge to ~1200px still leaves plenty of
      // resolution to decode reliably.
      const MAX_EDGE = 1200;
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let imageData;
      try {
        imageData = ctx.getImageData(0, 0, w, h);
      } catch {
        reject(new Error('อ่านรูปนี้ไม่ได้'));
        return;
      }
      const result = jsQR(imageData.data, w, h);
      if (!result || !result.data) {
        reject(new Error('ไม่พบ QR code ในรูปนี้ กรุณาลองรูปอื่น หรือกรอกรหัสด้วยตนเอง'));
        return;
      }
      resolve(result.data);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('เปิดรูปนี้ไม่ได้'));
    };
    img.src = objectUrl;
  });

  const pickReceiptImage = () => fileInputRef.current?.click();

  const handleReceiptImage = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // reset so choosing the same file again still fires onChange
    if (!file) return;
    setScanBusy(true);
    setClaimMsg(null);
    try {
      const raw = await decodeQrFromFile(file);
      await doClaim(extractClaimToken(raw).trim().toUpperCase());
    } catch (err) {
      setClaimMsg({ type: 'error', text: err.message || 'อ่าน QR จากรูปไม่สำเร็จ' });
    } finally {
      setScanBusy(false);
    }
  };

  // Close the QR modal with the Escape key (escape-routes).
  useEffect(() => {
    if (!redeem) return;
    const onKey = (e) => { if (e.key === 'Escape') closeRedeem(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redeem]);

  if (phase === 'loading') {
    return (
      <div className="cp-app" aria-busy="true" aria-label="กำลังโหลด">
        <div className="cp-skel" style={{ height: 42, width: 160 }} />
        <div className="cp-skel" style={{ height: 46, width: 220 }} />
        <div className="cp-skel" style={{ height: 300 }} />
        <div className="cp-skel" style={{ height: 72 }} />
        <div className="cp-skel" style={{ height: 180 }} />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="cp-center">
        <div className="cp-auth" style={{ textAlign: 'center' }}>
          <div className="cp-auth-head">
            <div className="cp-logo">K</div>
            <h2>เกิดข้อผิดพลาด</h2>
            <p style={{ wordBreak: 'break-word' }}>{error}</p>
          </div>
          <button className="cp-submit" onClick={bootstrap}>ลองใหม่อีกครั้ง</button>
        </div>
      </div>
    );
  }

  if (phase === 'register') {
    return (
      <div className="cp-center">
        <form className="cp-auth" onSubmit={submitRegister}>
          <div className="cp-auth-head">
            <div className="cp-logo">K</div>
            <h2>ยินดีต้อนรับ 🎉</h2>
            <p>กรอกข้อมูลเพื่อเชื่อมบัญชีสะสมแต้มของคุณ</p>
          </div>
          {error && <div className="cp-error-box" role="alert">{error}</div>}
          <div className="cp-field">
            <label htmlFor="reg-name">ชื่อ</label>
            <input id="reg-name" className="cp-input" value={regName} disabled readOnly />
          </div>
          <div className="cp-field">
            <label htmlFor="reg-phone">เบอร์โทร <span className="req">*</span></label>
            <input id="reg-phone" className="cp-input" type="tel" inputMode="tel" autoComplete="tel"
              value={regPhone} onChange={(e) => setRegPhone(e.target.value)} placeholder="08x-xxx-xxxx" autoFocus />
          </div>
          <div className="cp-field">
            <label>เพศ</label>
            <div className="cp-seg" role="group" aria-label="เพศ">
              {[['M', 'ชาย'], ['F', 'หญิง'], ['NA', 'ไม่ระบุ']].map(([v, label]) => (
                <button key={v} type="button" aria-pressed={regGender === v} onClick={() => setRegGender(v)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="cp-field">
            <label htmlFor="reg-dob">วันเกิด</label>
            <input id="reg-dob" className="cp-input" type="date" value={regDob} onChange={(e) => setRegDob(e.target.value)} />
          </div>
          <button className="cp-submit" type="submit" disabled={busy}>
            {busy ? 'กำลังบันทึก…' : 'เริ่มสะสมแต้ม'}
          </button>
        </form>
      </div>
    );
  }

  // ready
  const {
    customer, pointsBalance = 0, pointsPerFree = 0, maxFreeValue,
    pointsAvailable = 0, pointsHistory = [], coupons = [], recentOrders, shopName = 'KOTEA'
  } = data;
  const buyQty = pointsPerFree || 10;
  const inCycle = pointsPerFree > 0 ? pointsBalance % buyQty : 0;
  const remaining = buyQty - inCycle;
  // A pending code past its expiry is shown as expired without waiting for the
  // server to sweep it.
  const couponStatus = (c) =>
    c.status === 'pending' && c.expires_at && new Date(c.expires_at).getTime() < Date.now() ? 'expired' : c.status;

  return (
    <div className="cp-app">
      <header className="cp-header">
        <div className="cp-brand">
          <div className="cp-logo" aria-hidden="true">{shopName.trim().charAt(0).toUpperCase() || 'K'}</div>
          <div>
            <div className="cp-shop-name">{shopName}</div>
            <div className="cp-shop-sub">Rewards</div>
          </div>
        </div>
      </header>

      <section className="cp-greeting">
        <div className="cp-avatar" aria-hidden="true">{(customer.name || '?').trim().charAt(0)}</div>
        <div>
          <div className="cp-hello">สวัสดี,</div>
          <h1 className="cp-name">{customer.name}</h1>
        </div>
      </section>

      {claimMsg && (
        <div className={claimMsg.type === 'success' ? 'cp-free-pill' : 'cp-error-box'} role="alert"
          style={{ margin: '0 0 4px' }}>
          {claimMsg.type === 'success' && <GiftIcon />}{claimMsg.text}
        </div>
      )}

      <form className="cp-claim-card" onSubmit={submitClaimCode} aria-label="กรอกรหัสรับแต้มจากใบเสร็จ">
        <h3>มีรหัสจากใบเสร็จ?</h3>
        <div className="cp-claim-row">
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={handleReceiptImage} />
          <button type="button" className="cp-scan-btn" onClick={pickReceiptImage} disabled={claimBusy || scanBusy}
            aria-label="แนบรูปใบเสร็จเพื่ออ่าน QR">
            {scanBusy ? '…' : <GalleryIcon />}
          </button>
          <input className="cp-input" value={claimCodeInput} maxLength={6} placeholder="เช่น A1B2C3"
            autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            onChange={(e) => setClaimCodeInput(e.target.value.toUpperCase())} />
          <button className="cp-claim-btn" type="submit" disabled={claimBusy || !claimCodeInput.trim()}>
            {claimBusy ? '…' : 'รับแต้ม'}
          </button>
        </div>
        <p className="cp-claim-hint">หรือแนบรูปใบเสร็จที่ถ่าย/เซฟไว้ ให้ระบบอ่าน QR ให้อัตโนมัติ</p>
      </form>

      {pointsPerFree > 0 ? (
        <section className="cp-card" aria-label={`บัตรสะสมแต้ม ${inCycle} จาก ${buyQty} แต้ม`}>
          <Sparkle className="d1" />
          <Sparkle className="d2" />
          <Sparkle className="d3" />
          <div className="cp-count"><b>{inCycle}</b>/{buyQty}</div>
          <div className="cp-card-script">{shopName.charAt(0).toUpperCase() + shopName.slice(1).toLowerCase()}</div>
          <h2 className="cp-card-heading">Loyalty Card</h2>
          <div className="cp-card-sub">
            สะสมครบ {buyQty} แต้ม รับฟรี 1 แก้ว{maxFreeValue > 0 && ` (เมนูไม่เกิน ${money(maxFreeValue)})`}
          </div>
          <div className="cp-stamps">
            {Array.from({ length: buyQty }).map((_, i) => {
              const earned = i < inCycle;
              const last = i === buyQty - 1;
              return (
                <div key={i} className={`cp-stamp${earned ? ' is-earned' : ''}`}
                  aria-label={earned ? `แต้มที่ ${i + 1} ได้รับแล้ว` : last ? `แต้มที่ ${i + 1} ครบแล้วรับฟรี` : `แต้มที่ ${i + 1}`}>
                  <Scallop earned={earned} />
                  {earned ? <CupArt /> : last ? <span className="cp-free-label">FREE</span> : null}
                </div>
              );
            })}
          </div>
          <div className="cp-card-note">
            {pointsAvailable > 0 ? 'คุณมีสิทธิ์แลกเครื่องดื่มฟรีแล้ว!' : `สะสมอีก ${remaining} แต้ม รับฟรี 1 แก้ว`}
          </div>
          {pointsAvailable > 0 && (
            <div className="cp-free-pill"><GiftIcon />แลกฟรีได้ {pointsAvailable} แก้ว</div>
          )}
          <button className="cp-redeem" disabled={busy || pointsAvailable < 1} onClick={doRedeem}>
            <GiftIcon />
            {busy ? 'กำลังสร้างคูปอง…' : pointsAvailable < 1 ? `สะสมอีก ${remaining} แต้มเพื่อแลกฟรี` : 'แลกรับแก้วฟรี'}
          </button>
          {error && <div className="cp-error-box" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
        </section>
      ) : (
        <section className="cp-panel"><div className="cp-empty">ยังไม่มีโปรโมชั่นที่เปิดใช้งาน</div></section>
      )}

      <section className="cp-stats" aria-label="สถิติการสะสม">
        <div className="cp-stat"><div className="label">สะสมรอบนี้</div><div className="value">{inCycle}/{buyQty}</div></div>
        <div className="cp-stat"><div className="label">แลกฟรีได้</div><div className="value good">{pointsAvailable}</div></div>
        <div className="cp-stat"><div className="label">แต้มสะสม</div><div className="value">{pointsBalance}</div></div>
      </section>

      <div className="cp-tabs" role="tablist" aria-label="ประวัติ">
        <button className="cp-tab" role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>
          ประวัติการสั่งซื้อ
        </button>
        <button className="cp-tab" role="tab" aria-selected={tab === 'coupons'} onClick={() => setTab('coupons')}>
          ประวัติคูปอง
        </button>
        <button className="cp-tab" role="tab" aria-selected={tab === 'points'} onClick={() => setTab('points')}>
          ประวัติแต้ม
        </button>
      </div>

      {tab === 'orders' && (
        <section className="cp-panel" role="tabpanel" aria-label="ประวัติการสั่งซื้อ">
          {recentOrders && recentOrders.length ? recentOrders.map((o, i) => (
            <div className="cp-row" key={i}>
              <div className="cp-row-main">
                <div className="cp-row-title">
                  {o.menu_name}
                  {o.is_free === '1' && <span className="cp-badge free">ฟรี</span>}
                </div>
                <div className="cp-row-sub">{fmtDate(o.date)}</div>
              </div>
              <div className="cp-row-end">
                <div className="cp-price">{o.is_free === '1' ? '—' : money(o.total_price)}</div>
              </div>
            </div>
          )) : (
            <div className="cp-empty"><ReceiptIcon /><div>ยังไม่มีประวัติการซื้อ</div></div>
          )}
        </section>
      )}

      {tab === 'coupons' && (
        <section className="cp-panel" role="tabpanel" aria-label="ประวัติคูปอง">
          {coupons.length ? coupons.map((c, i) => {
            const st = couponStatus(c);
            return (
              <div className="cp-row" key={i}>
                <div className="cp-row-main">
                  <div className="cp-row-title cp-code">{c.code}</div>
                  <div className="cp-row-sub">
                    {st === 'used' ? `ใช้เมื่อ ${fmtDateTime(c.used_at)}` : `สร้างเมื่อ ${fmtDateTime(c.created_at)}`}
                  </div>
                </div>
                <div className="cp-row-end">
                  <span className={`cp-badge ${st}`}>{COUPON_LABEL[st] || st}</span>
                </div>
              </div>
            );
          }) : (
            <div className="cp-empty"><TicketIcon /><div>ยังไม่เคยแลกคูปอง</div></div>
          )}
        </section>
      )}

      {tab === 'points' && (
        <section className="cp-panel" role="tabpanel" aria-label="ประวัติแต้ม">
          {pointsHistory.length ? pointsHistory.map((p, i) => {
            const pts = Number(p.points) || 0;
            return (
              <div className="cp-row" key={i}>
                <div className="cp-row-main">
                  <div className="cp-row-title">
                    {POINTS_LABEL[p.kind] || 'แต้ม'}
                    {p.kind === 'spend' && p.order_no && <span className="cp-row-sub" style={{ marginLeft: 6 }}>#{p.order_no}</span>}
                  </div>
                  <div className="cp-row-sub">
                    {p.note ? `${p.note} · ` : ''}{fmtDateTime(p.claimed_at || p.created_at)}
                  </div>
                </div>
                <div className="cp-row-end">
                  <div className="cp-price" style={{ color: pts > 0 ? 'var(--cp-success, #3d7a3d)' : undefined }}>
                    {pts > 0 ? `+${pts}` : pts}
                  </div>
                </div>
              </div>
            );
          }) : (
            <div className="cp-empty"><StarIcon /><div>ยังไม่มีประวัติแต้ม</div></div>
          )}
        </section>
      )}

      {redeem && (
        <div className="cp-scrim" onClick={(e) => { if (e.target === e.currentTarget) closeRedeem(); }}>
          <div className="cp-modal" role="dialog" aria-modal="true" aria-label="คูปองแลกแก้วฟรี">
            <button className="cp-modal-close" onClick={closeRedeem} aria-label="ปิด">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
            <h2>คูปองแลกแก้วฟรี</h2>
            <div className="cp-modal-sub">แสดงโค้ดนี้ให้พนักงานที่เคาน์เตอร์</div>
            <div className="cp-qr-box">
              {qrUrl && <img src={qrUrl} alt={`QR code สำหรับโค้ด ${redeem.code}`} />}
            </div>
            <div className="cp-modal-code-label">รหัสคูปอง</div>
            <div className="cp-modal-code">{redeem.code}</div>
            <div className="cp-modal-hint">
              {redeem.max_free_value > 0 && <>ใช้กับเมนูราคาไม่เกิน {money(redeem.max_free_value)}<br /></>}
              คูปองหมดอายุใน 1 ชั่วโมง
            </div>
            <button className="cp-modal-done" onClick={closeRedeem}>เสร็จสิ้น</button>
          </div>
        </div>
      )}
    </div>
  );
}
