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
  const [busy, setBusy] = useState(false);
  const [redeem, setRedeem] = useState(null);    // { code, expires_at }
  const [qrUrl, setQrUrl] = useState('');

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
      const res = await customerApi.register({ phone: regPhone.trim(), name: regName.trim() }, pendingToken);
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
          <input className="form-control" value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="ชื่อของคุณ" />
        </div>
        <div className="field"><label>เบอร์โทร</label>
          <input className="form-control" type="tel" value={regPhone} onChange={(e) => setRegPhone(e.target.value)} placeholder="08x-xxx-xxxx" autoFocus />
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'กำลังบันทึก…' : 'เริ่มสะสมแต้ม'}
        </button>
      </form>
    </Centered>;
  }

  // ready
  const { customer, promotion, loyalty, recentOrders } = data;
  const buyQty = promotion ? Number(promotion.buy_qty) : 10;
  const inCycle = promotion ? loyalty.purchased % buyQty : 0;

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="logo" style={{ margin: '0 auto 8px' }}>K</div>
        <h3 style={{ margin: 0 }}>สวัสดี {customer.name}</h3>
        <p className="helper-text">บัตรสะสมแต้ม KOTEA Rewards</p>
      </div>

      {promotion ? (
        <div className="card">
          <div className="card-header"><h3>{promotion.name}</h3></div>
          <StampRow filled={inCycle} total={buyQty} />
          <div className="grid-3" style={{ marginTop: 12 }}>
            <div className="stat-pill"><div className="label">สะสมรอบนี้</div><div className="value">{inCycle}/{buyQty}</div></div>
            <div className="stat-pill"><div className="label">แก้วฟรีที่ใช้ได้</div><div className="value" style={{ color: 'var(--success-color)' }}>{loyalty.available}</div></div>
            <div className="stat-pill"><div className="label">ซื้อสะสมทั้งหมด</div><div className="value">{loyalty.purchased}</div></div>
          </div>
          {loyalty.pending > 0 && (
            <p className="helper-text" style={{ marginTop: 8 }}>มีโค้ดที่รอใช้อยู่ {loyalty.pending} โค้ด</p>
          )}
          <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} disabled={busy || loyalty.available < 1} onClick={doRedeem}>
            {loyalty.available < 1 ? `สะสมอีก ${buyQty - inCycle} แก้วเพื่อรับฟรี` : '🎁 แลกแก้วฟรี'}
          </button>
          {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
      ) : (
        <div className="card"><p className="helper-text">ยังไม่มีโปรโมชั่นที่เปิดใช้งาน</p></div>
      )}

      {redeem && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="card-header"><h3>โค้ดแลกแก้วฟรี</h3></div>
          <p className="helper-text">แสดงโค้ดนี้ให้พนักงานที่เคาน์เตอร์</p>
          {qrUrl && <img src={qrUrl} alt="QR" style={{ width: 200, height: 200, margin: '8px auto' }} />}
          <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 6, fontFamily: 'DM Mono, monospace' }}>{redeem.code}</div>
          {redeem.max_free_value > 0 && (
            <p className="helper-text" style={{ marginTop: 8 }}>ใช้กับเมนูราคาไม่เกิน {money(redeem.max_free_value)}</p>
          )}
          <p className="helper-text">โค้ดหมดอายุใน 30 นาที</p>
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

// Row of stamp dots — filled ones marked, the rest empty.
function StampRow({ filled, total }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} style={{
          width: 36, height: 36, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 600,
          background: i < filled ? 'var(--olive-700, #5b6236)' : 'transparent',
          color: i < filled ? '#fff' : 'var(--text-muted)',
          border: `2px solid ${i < filled ? 'var(--olive-700, #5b6236)' : 'var(--border-color, #ddd)'}`
        }}>{i < filled ? '☕' : i + 1}</div>
      ))}
    </div>
  );
}
