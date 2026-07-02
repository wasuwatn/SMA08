import React from 'react';
import { useData } from './lib/data.jsx';
import Login from './pages/Login.jsx';
import ChangePassword from './components/ChangePassword.jsx';
import Toasts from './components/Toasts.jsx';

// Minimal chrome shared by the POS and Expense satellite apps: a login gate, an
// online/offline + queue indicator, and the single page this app exists for.
export default function SatelliteApp({ title, icon, access, Page }) {
  const { user, logout, online, pending } = useData();

  if (!user) return (<><Login /><Toasts /></>);
  if (user.mustChangePassword) return (<><ChangePassword /><Toasts /></>);

  const allowed = user.role === 'Admin' || user.access.split(',').includes(access);
  if (!allowed) return (
    <>
      <div className="login-overlay">
        <form className="login-card" onSubmit={(e) => e.preventDefault()}>
          <div className="logo">K</div>
          <h2>{title}</h2>
          <p className="sub">This account has no access to {title}.</p>
          <button className="btn btn-primary btn-block" onClick={logout}>Sign out</button>
        </form>
      </div>
      <Toasts />
    </>
  );

  return (
    <div className="app-shell">
      <div className="main">
        <header className="header">
          <h1><i className={`fa-solid ${icon}`}></i> {title}</h1>
          <div className="header-right">
            <span className={`badge ${online ? 'bg-green' : 'local'}`}>
              <i className="fa-solid fa-circle"></i> {online ? 'Online' : 'Offline'}
              {pending > 0 ? ` · ${pending} queued` : ''}
            </span>
            <span className="badge bg-gray">{user.username}</span>
            <button className="btn btn-sm btn-secondary" onClick={logout} title="Log out">
              <i className="fa-solid fa-right-from-bracket"></i>
            </button>
          </div>
        </header>
        <main className="page"><Page /></main>
      </div>
      <Toasts />
    </div>
  );
}
