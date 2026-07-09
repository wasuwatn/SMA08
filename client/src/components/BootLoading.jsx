import React from 'react';

function Spinner() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" className="login-spinner" style={{ margin: '0 auto' }}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--border-color)" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" fill="none" stroke="var(--primary)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Shown while DataProvider is restoring a saved session (checking the token
// and pulling the first batch of tables) so the app never flashes an
// authenticated shell with empty data — see the `booting` flag in
// lib/data.jsx. Reuses the login screen's visual language (same blobs/card)
// so the boot sequence reads as one continuous screen, not a glitch.
export default function BootLoading() {
  return (
    <div className="login-overlay">
      <div className="login-blob a" />
      <div className="login-blob b" />
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="logo">K</div>
        <h2 style={{ fontSize: 20, marginBottom: 4 }}>กำลังเชื่อมต่อเซิร์ฟเวอร์...</h2>
        <p className="sub" style={{ textTransform: 'none', letterSpacing: 'normal', fontSize: 13 }}>
          KOTEA Store Management · V08
        </p>
        <div style={{ margin: '28px 0' }}><Spinner /></div>
        <p className="login-hint">
          การเชื่อมต่อครั้งแรกอาจใช้เวลาถึง 1 นาที<br />
          หากเซิร์ฟเวอร์เพิ่งถูกปลุกจากโหมดพัก
        </p>
      </div>
    </div>
  );
}
