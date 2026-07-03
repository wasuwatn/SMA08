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

export default function CustomerPortal() {
  const [phase, setPhase] = useState('loading'); // loading | register | ready | error
  const [error, setError] = useState('');
  const [data, setData] = useState(null);        // { customer, promotion, loyalty, recentOrders }
  const [pendingToken, setPendingToken] = useState('');
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regGender, setRegGender] = useState('NA');
  const [regDob, setRegDob] = useState('');
  const [regFavorites, setRegFavorites] = useState([]);
  const [menuOptions, setMenuOptions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [redeem, setRedeem] = useState(null);    // { code, expires_at }
  const [qrUrl, setQrUrl] = useState('');
  const [rewardTab, setRewardTab] = useState('unclaimed'); // unclaimed | claimed

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
      setQrUrl(await QRCode.toDataURL(r.code, { width: 220, margin: 1 }));
      await loadMe(); // refresh available/pending counts
    } catch (e) {
      setError(e.message || 'แลกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'loading') {
    return <Centered><div className="helper-text">กำลังโหลด…</div></Centered>;
  }

  if (phase === 'error') {
    return <Centered>
      <div className="card" style={{ maxWidth: 360, textAlign: 'center' }}>
        <div className="logo" style={{ margin: '0 auto 12px' }}>K</div>
        <h3>เกิดข้อผิดพลาด</h3>
        <p className="helper-text" style={{ wordBreak: 'break-word' }}>{error}</p>
        <button className="btn btn-secondary btn-block" style={{ marginTop: 16 }} onClick={bootstrap}>
          ลองใหม่อีกครั้ง
        </button>
      </div>
    </Centered>;
  }

  if (phase === 'register') {
    return <Centered>
      <form className="card" style={{ maxWidth: 360, width: '100%' }} onSubmit={submitRegister}>
        <div className="logo" style={{ margin: '0 auto 12px' }}>K</div>
        <h3 style={{ textAlign: 'center' }}>ยินดีต้อนรับ 🎉</h3>
        <p className="helper-text" style={{ textAlign: 'center', marginBottom: 16 }}>
          กรอกข้อมูลเพื่อเชื่อมบัญชีสะสมแต้มของคุณ
        </p>
        {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="field"><label>ชื่อ</label>
          <input className="form-control" value={regName} disabled readOnly />
        </div>
        <div className="field"><label>เบอร์โทร</label>
          <input className="form-control" type="tel" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} placeholder="08x-xxx-xxxx" autoFocus />
        </div>
        <div className="field"><label>เพศ</label>
          <select className="form-control" value={regGender} onChange={(e) => setRegGender(e.target.value)}>
            <option value="M">ชาย</option>
            <option value="F">หญิง</option>
            <option value="NA">ไม่ระบุ</option>
          </select>
        </div>
        <div className="field"><label>วันเกิด</label>
          <input className="form-control" type="date" value={regDob} onChange={(e) => setRegDob(e.target.value)} />
        </div>
        {menuOptions.length > 0 && (
          <div className="field"><label>ชอบกินเมนูอะไร</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {menuOptions.map(name => (
                <label key={name} className="badge local" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={regFavorites.includes(name)} onChange={() => toggleFavorite(name)} />
                  {name}
                </label>
              ))}
            </div>
          </div>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : 'เริ่มสะสมแต้ม'}
        </button>
      </form>
    </Centered>;
  }

  // ready
  const { promotion, loyalty, recentOrders } = data;
  const buyQty = promotion ? Number(promotion.buy_qty) : 10;
  const inCycle = promotion ? loyalty.purchased % buyQty : 0;
  const remaining = promotion ? buyQty - inCycle : 0;
  const claimedOrders = (recentOrders || []).filter(o => o.is_free === '1');
  const closeLiff = () => { if (window.liff && window.liff.closeWindow) window.liff.closeWindow(); };

  return (
    <div className="reward-page">
      <div className="reward-topbar">
        <span className="reward-topbar-title">บัตรสะสมแต้ม</span>
        <button className="reward-icon-btn" onClick={closeLiff} aria-label="ปิด"><i className="fa-solid fa-xmark"></i></button>
      </div>

      <div className="reward-hero">KOTEA</div>

      {promotion ? (
        <div className="reward-card">
          <div className="reward-card-avatar"><i className="fa-solid fa-mug-hot"></i></div>
          <h2 className="store-name">KOTEA House</h2>
          <p className="expiry">ไม่มีวันหมดอายุ</p>
          <p className="headline">{promotion.name || `ซื้อครบ ${buyQty} แถม 1`}</p>

          <div className="reward-badge-row">
            <span className="reward-badge"><i className="fa-solid fa-star"></i> รางวัล</span>
            <span className="reward-badge-text">
              {loyalty.available >= 1 ? 'พร้อมแลกรางวัลแล้ว!' : `อีก ${remaining} ดวงถึงรางวัล`}
            </span>
          </div>

          <div className="stamp-grid">
            {Array.from({ length: buyQty }).map((_, i) => {
              const isRewardSlot = i === buyQty - 1;
              const filled = i < inCycle;
              return (
                <div key={i} className={`stamp${filled ? ' filled' : ''}${isRewardSlot ? ' reward-slot' : ''}`}>
                  {isRewardSlot ? <i className="fa-solid fa-star"></i> : (filled ? <i className="fa-solid fa-check"></i> : i + 1)}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="card"><p className="helper-text">ยังไม่มีโปรโมชั่นที่เปิดใช้งาน</p></div>
      )}

      {promotion && (
        <button className="btn btn-primary btn-block reward-redeem-btn" disabled={busy || loyalty.available < 1} onClick={doRedeem}>
          {loyalty.available < 1 ? `สะสมอีก ${remaining} แก้วเพื่อรับฟรี` : '🎁 แลกแก้วฟรี'}
        </button>
      )}
      {error && <div className="login-error">{error}</div>}

      {redeem && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="card-header"><h3>โค้ดแลกแก้วฟรี</h3></div>
          <p className="helper-text">แสดงโค้ดนี้ให้พนักงานที่เคาน์เตอร์</p>
          {qrUrl && <img src={qrUrl} alt="QR" style={{ width: 200, height: 200, margin: '8px auto', display: 'block' }} />}
          <p className="helper-text" style={{ marginBottom: 4 }}>รหัส</p>
          <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 6, fontFamily: 'DM Mono, monospace' }}>{redeem.code}</div>
          {redeem.max_free_value > 0 && (
            <p className="helper-text" style={{ marginTop: 8 }}>ใช้กับเมนูราคาไม่เกิน {money(redeem.max_free_value)}</p>
          )}
          <p className="helper-text">โค้ดหมดอายุใน 1 ชั่วโมง</p>
        </div>
      )}

      <div className="page-tabs reward-tabs">
        <button className={`page-tab${rewardTab === 'unclaimed' ? ' active' : ''}`} onClick={() => setRewardTab('unclaimed')}>รางวัลที่ยังไม่ได้รับ</button>
        <button className={`page-tab${rewardTab === 'claimed' ? ' active' : ''}`} onClick={() => setRewardTab('claimed')}>รางวัลที่แลกแล้ว</button>
      </div>

      {rewardTab === 'unclaimed' ? (
        <div className="reward-list">
          {promotion ? (
            <div className="reward-list-item">
              <div className="reward-list-thumb"><i className="fa-solid fa-gift"></i></div>
              <div className="reward-list-meta">
                <div className="reward-list-title">1 แก้วฟรี!</div>
                <div className="reward-list-sub">
                  {loyalty.available >= 1 ? 'พร้อมแลกได้เลย' : `ต้องสะสมอีก ${remaining} ดวง`}
                </div>
              </div>
              {loyalty.available < 1 && <i className="fa-solid fa-lock reward-list-lock"></i>}
            </div>
          ) : <p className="helper-text">ยังไม่มีรางวัล</p>}
          {loyalty.pending > 0 && (
            <div className="reward-list-item">
              <div className="reward-list-thumb"><i className="fa-solid fa-clock"></i></div>
              <div className="reward-list-meta">
                <div className="reward-list-title">โค้ดที่รอใช้ {loyalty.pending} รายการ</div>
                <div className="reward-list-sub">แสดงโค้ดที่เคาน์เตอร์ภายใน 1 ชั่วโมง</div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="reward-list">
          {claimedOrders.length ? claimedOrders.map((o, i) => (
            <div className="reward-list-item" key={i}>
              <div className="reward-list-thumb claimed"><i className="fa-solid fa-check"></i></div>
              <div className="reward-list-meta">
                <div className="reward-list-title">{o.menu_name}</div>
                <div className="reward-list-sub">{o.date}</div>
              </div>
            </div>
          )) : <p className="helper-text" style={{ padding: '10px 2px' }}>ยังไม่มีรางวัลที่แลกแล้ว</p>}
        </div>
      )}

      <div className="card">
        <div className="card-header"><h3>ประวัติล่าสุด</h3></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>วันที่</th><th>เมนู</th><th>ราคา</th></tr></thead>
            <tbody>
              {recentOrders && recentOrders.length ? recentOrders.map((o, i) => (
                <tr key={i}>
                  <td><span className="helper-text">{o.date}</span></td>
                  <td>{o.menu_name}{o.is_free === '1' && <span className="badge local" style={{ marginLeft: 6 }}>🎁 ฟรี</span>}</td>
                  <td>{o.is_free === '1' ? '—' : money(o.total_price)}</td>
                </tr>
              )) : <tr className="empty-row"><td colSpan={3}>ยังไม่มีประวัติการซื้อ</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>{children}</div>;
}
