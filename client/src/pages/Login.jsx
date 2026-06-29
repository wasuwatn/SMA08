import React, { useState } from 'react';
import { useData } from '../lib/data.jsx';

function EyeIcon({ open }) {
  return open ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" className="login-spinner">
      <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function Login() {
  const { login, pushToast } = useData();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = await login(username, password);
      pushToast(`Welcome back, ${u.username}!`, 'success');
    } catch (err) {
      setError('Invalid username or password. Please try again.');
      pushToast('Invalid credentials, please try again.', 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-overlay">
      <div className="login-blob a" />
      <div className="login-blob b" />
      <form className="login-card" onSubmit={submit}>
        <div className="logo">K</div>
        <h2>KOTEA Cozy Cafe</h2>
        <p className="sub">Store Management System · V08</p>
        <div className="login-divider" />
        <div className="login-form">
          {error && <div className="login-error">{error}</div>}
          <div className="login-field">
            <label>Username</label>
            <div className="input-wrap">
              <input value={username} autoFocus
                onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
            </div>
          </div>
          <div className="login-field">
            <label>Password</label>
            <div className="input-wrap has-toggle">
              <input type={showPw ? 'text' : 'password'} value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
              <button type="button" className="login-pw-toggle" onClick={() => setShowPw((p) => !p)}
                aria-label={showPw ? 'Hide password' : 'Show password'}>
                <EyeIcon open={showPw} />
              </button>
            </div>
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? (<><Spinner /> Signing in…</>) : 'Sign In'}
          </button>
          <div className="login-hint">
            Default: <strong>admin / admin</strong> or <strong>staff / staff</strong>
          </div>
        </div>
      </form>
    </div>
  );
}
