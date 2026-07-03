import React, { useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
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

/* ---- SVG icons — one stroke family (2px, round) ---------------------------- */
const CupOutline = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 8.5h11l-1.3 11a1.5 1.5 0 0 1-1.5 1.3H9.3a1.5 1.5 0 0 1-1.5-1.3l-1.3-11Z" />
    <path d="M10 8.5 12.8 3l2.7 1" />
  </svg>
);
// Earned stamp: filled cup with pearls — deliberately a different glyph from the
// outline so a collected stamp reads at a glance.
const CupFilled = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6.5 8.5h11l-1.3 11a1.5 1.5 0 0 1-1.5 1.3H9.3a1.5 1.5 0 0 1-1.5-1.3l-1.3-11Z" fill="currentColor" />
    <path d="M10 8.5 12.8 3l2.7 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="10" cy="16.5" r="1.15" fill="#fff" />
    <circle cx="13.8" cy="16.5" r="1.15" fill="#fff" />
    <circle cx="11.9" cy="13.2" r="1.15" fill="#fff" />
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

const COUPON_LABEL = { pending: 'รอใช้งาน', used: 'ใช้แล้ว', expired: 'หมดอายุ' };

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

export default function CustomerPortal() {
  const [phase, setPhase] = useState('loading'); // loading | register | ready | error
  const [error, setError] = useState('');
  const [data, setData] = useState(null);        // { customer, promotion, loyalty, recentOrders, coupons, shopName }
  const [pendingToken, setPendingToken] = useState('');
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regGender, setRegGender] = useState('NA');
  const [regDob, setRegDob] = useState('');
  const [regFavorites, setRegFavorites] = useState([]);
  const [menuOptions, setMenuOptions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [redeem, setRedeem] = useState(null);    // { code, expires_at, max_free_value }
  const [qrUrl, setQrUrl] = useState('');
  const [tab, setTab] = useState('orders');      // orders | coupons

  useEffect(() => {
    customerApi.menuOptions().then(setMenuOptions).catch(() => setMenuOptions([]));
  }, []);

  const toggleFavorite = (name) => {
    setRegFavorites(list => list.includes(name) ? list.filter(n => n !== name) : [...list, name]);
  };

  const loadMe = useCallback(async () => {
    const me = await customerApi.me();
    setData(me);
    setPhase('ready');
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const liffId = import.meta.env.VITE_LIFF_ID;
      const devUser = import.meta.env.VITE_DEV_LINE_USER; // local testing only
      let loginBody;
      if (liffId) {
        let liff;
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
        date_of_birth: regDob || null, favorite_menu: regFavorites
      }, pendingToken);
      setToken(res.token);
      await loadMe();
    } catch (e) {
      setError(e.message || 'ลงทะเบียนไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

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
          {menuOptions.length > 0 && (
            <div className="cp-field">
              <label>ชอบกินเมนูอะไร</label>
              <div className="cp-chips">
                {menuOptions.map(name => (
                  <button key={name} type="button" className="cp-chip"
                    aria-pressed={regFavorites.includes(name)} onClick={() => toggleFavorite(name)}>
                    {regFavorites.includes(name) && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6.5" /></svg>
                    )}
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button className="cp-submit" type="submit" disabled={busy}>
            {busy ? 'กำลังบันทึก…' : 'เริ่มสะสมแต้ม'}
          </button>
        </form>
      </div>
    );
  }

  // ready
  const { customer, promotion, loyalty, recentOrders, coupons = [], shopName = 'KOTEA' } = data;
  const buyQty = promotion ? Number(promotion.buy_qty) : 10;
  const inCycle = promotion ? loyalty.purchased % buyQty : 0;
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

      {promotion ? (
        <section className="cp-card" aria-label={`บัตรสะสมแต้ม ${inCycle} จาก ${buyQty} แต้ม`}>
          <div className="cp-card-top">
            <div className="cp-promo-name">{promotion.name}</div>
            <div className="cp-cycle"><b>{inCycle}</b>/{buyQty}</div>
          </div>
          <div className="cp-card-sub">ซื้อครบ {buyQty} แก้ว รับฟรี 1 แก้ว</div>
          <div className="cp-stamps">
            {Array.from({ length: buyQty }).map((_, i) => {
              const earned = i < inCycle;
              const next = i === inCycle;
              return (
                <div key={i} className={`cp-stamp${earned ? ' is-earned' : ''}${next ? ' is-next' : ''}`}
                  aria-label={earned ? `แต้มที่ ${i + 1} ได้รับแล้ว` : `แต้มที่ ${i + 1}`}>
                  {earned ? <CupFilled /> : <CupOutline />}
                </div>
              );
            })}
          </div>
          <div className="cp-card-note">
            {loyalty.available > 0 ? 'คุณมีสิทธิ์แลกเครื่องดื่มฟรีแล้ว!' : `สะสมอีก ${remaining} แก้ว รับฟรี 1 แก้ว`}
          </div>
          {loyalty.available > 0 && (
            <div className="cp-free-pill"><GiftIcon />แลกฟรีได้ {loyalty.available} แก้ว</div>
          )}
          <button className="cp-redeem" disabled={busy || loyalty.available < 1} onClick={doRedeem}>
            <GiftIcon />
            {busy ? 'กำลังสร้างคูปอง…' : loyalty.available < 1 ? `สะสมอีก ${remaining} แก้วเพื่อแลกฟรี` : 'แลกรับแก้วฟรี'}
          </button>
          {error && <div className="cp-error-box" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}
        </section>
      ) : (
        <section className="cp-panel"><div className="cp-empty">ยังไม่มีโปรโมชั่นที่เปิดใช้งาน</div></section>
      )}

      <section className="cp-stats" aria-label="สถิติการสะสม">
        <div className="cp-stat"><div className="label">สะสมรอบนี้</div><div className="value">{inCycle}/{buyQty}</div></div>
        <div className="cp-stat"><div className="label">แลกฟรีได้</div><div className="value good">{loyalty.available}</div></div>
        <div className="cp-stat"><div className="label">ซื้อทั้งหมด</div><div className="value">{loyalty.purchased}</div></div>
      </section>

      <div className="cp-tabs" role="tablist" aria-label="ประวัติ">
        <button className="cp-tab" role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>
          ประวัติการสั่งซื้อ
        </button>
        <button className="cp-tab" role="tab" aria-selected={tab === 'coupons'} onClick={() => setTab('coupons')}>
          ประวัติการใช้คูปอง
        </button>
      </div>

      {tab === 'orders' ? (
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
      ) : (
        <section className="cp-panel" role="tabpanel" aria-label="ประวัติการใช้คูปอง">
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
