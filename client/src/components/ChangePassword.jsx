import React, { useState } from 'react';
import { useData } from '../lib/data.jsx';

// Full-screen gate shown after logging in with a default password
// (username == password). The app stays locked until a real one is set.
export default function ChangePassword() {
  const { user, changePassword, logout, pushToast } = useData();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (next.length < 6) return setError('New password must be at least 6 characters.');
    if (next !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await changePassword(current, next);
      pushToast('Password updated.', 'success');
    } catch (err) {
      setError(err.message || 'Could not change password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-overlay">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">K</div>
        <h2>Set a new password</h2>
        <p className="sub">
          The account <strong>{user.username}</strong> is still using its default password.
          Choose a new one to continue.
        </p>
        <div className="login-divider" />
        <div className="login-form">
          {error && <div className="login-error">{error}</div>}
          <div className="login-field">
            <label>Current password</label>
            <div className="input-wrap">
              <input type="password" value={current} autoFocus onChange={(e) => setCurrent(e.target.value)} />
            </div>
          </div>
          <div className="login-field">
            <label>New password</label>
            <div className="input-wrap">
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
          </div>
          <div className="login-field">
            <label>Confirm new password</label>
            <div className="input-wrap">
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
          <button className="btn btn-secondary btn-block" type="button" onClick={logout}>
            Sign out
          </button>
        </div>
      </form>
    </div>
  );
}
