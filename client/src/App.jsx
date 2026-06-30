import React, { useState, useMemo } from 'react';
import { useData } from './lib/data.jsx';
import Toasts from './components/Toasts.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Delivery from './pages/Delivery.jsx';
import SalesLog from './pages/SalesLog.jsx';
import ExpenseLog from './pages/ExpenseLog.jsx';
import Materials from './pages/Materials.jsx';
import Inventory from './pages/Inventory.jsx';
import Recipes from './pages/Recipes.jsx';
import Customers from './pages/Customers.jsx';
import CRM from './pages/CRM.jsx';
import Promotions from './pages/Promotions.jsx';
import Users from './pages/Users.jsx';
import DailyCups from './pages/DailyCups.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  { group: 'Overview', items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'fa-chart-line', access: 'dashboard' },
    { id: 'dailycups', label: 'Daily Cups', icon: 'fa-mug-hot', access: 'daily' }
  ]},
  // POS checkout and expense entry live in their own satellite apps (pos.html / expense.html).
  { group: 'Sales', items: [
    { id: 'delivery', label: 'Delivery', icon: 'fa-motorcycle', access: 'delivery' },
    { id: 'saleslog', label: 'Transaction Log', icon: 'fa-receipt', access: 'pos' }
  ]},
  { group: 'Finance', items: [
    { id: 'expenselog', label: 'Expense Log', icon: 'fa-file-invoice-dollar', access: 'expenses' }
  ]},
  { group: 'Inventory', items: [
    { id: 'materials', label: 'Material Master', icon: 'fa-boxes-stacked', access: 'materials' },
    { id: 'inventory', label: 'Stock', icon: 'fa-warehouse', access: 'stock' },
    { id: 'recipes', label: 'Recipes / BOM', icon: 'fa-flask', access: 'bom' }
  ]},
  { group: 'Relations', items: [
    { id: 'customers', label: 'Customers', icon: 'fa-address-book', access: 'customers' },
    { id: 'crm', label: 'CRM Analytics', icon: 'fa-users-viewfinder', access: 'customers' },
    { id: 'promotions', label: 'Promotions', icon: 'fa-gift', access: 'promotions' }
  ]},
  { group: 'Administration', items: [
    { id: 'users', label: 'Users', icon: 'fa-user-shield', access: 'users' },
    { id: 'settings', label: 'Settings', icon: 'fa-gear', access: 'settings' }
  ]}
];

const PAGES = {
  dashboard: Dashboard, delivery: Delivery, saleslog: SalesLog, expenselog: ExpenseLog, materials: Materials,
  inventory: Inventory, recipes: Recipes, customers: Customers,
  crm: CRM, promotions: Promotions, users: Users, dailycups: DailyCups, settings: Settings
};

const ALL_FLAT = NAV.flatMap(g => g.items);

export default function App() {
  const { user, logout, settings, pushToast, online } = useData();
  const [tab, setTab] = useState('dashboard');
  const [year, setYear] = useState(2026);
  const [navOpen, setNavOpen] = useState(false); // mobile sidebar drawer

  const canAccess = (access) =>
    user && (user.role === 'Admin' || user.access.split(',').includes(access));

  // Ensure current tab is permitted; otherwise fall back to first allowed.
  const activeTab = useMemo(() => {
    if (!user) return 'dashboard';
    const cur = ALL_FLAT.find(i => i.id === tab);
    if (cur && canAccess(cur.access)) return tab;
    const first = ALL_FLAT.find(i => canAccess(i.access));
    return first ? first.id : 'dashboard';
  }, [tab, user]); // eslint-disable-line

  if (!user) return (<><Login /><Toasts /></>);

  const Page = PAGES[activeTab];
  const activeMeta = ALL_FLAT.find(i => i.id === activeTab);
  const logo = settings.logo;

  const go = (item) => {
    if (!canAccess(item.access)) { pushToast('Access denied for this section.', 'warning'); return; }
    setTab(item.id);
    setNavOpen(false); // close the drawer after navigating on mobile
  };

  return (
    <div className="app-shell">
      {navOpen && <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">{logo ? <img src={logo} alt="logo" /> : 'K'}</div>
          <div>
            <div className="brand-name">KOTEA</div>
            <div className="brand-sub">Store Management · V08</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map(group => {
            const visible = group.items.filter(i => canAccess(i.access));
            if (!visible.length) return null;
            return (
              <div key={group.group}>
                <div className="nav-group-label">{group.group}</div>
                {visible.map(item => (
                  <button
                    key={item.id}
                    className={`nav-item ${item.id === activeTab ? 'active' : ''}`}
                    onClick={() => go(item)}
                  >
                    <i className={`fa-solid ${item.icon}`}></i>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="user-panel">
          <div className="avatar">{user.username.charAt(0).toUpperCase()}</div>
          <div className="user-meta">
            <div className="u">{user.username}</div>
            <div className="r">{user.role === 'Admin' ? 'Administrator' : 'Staff'}</div>
          </div>
          <button className="btn btn-sm btn-secondary" onClick={logout} title="Log out">
            <i className="fa-solid fa-right-from-bracket"></i>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="header">
          <button className="nav-toggle" onClick={() => setNavOpen(o => !o)} aria-label="Menu">
            <i className="fa-solid fa-bars"></i>
          </button>
          <h1>{activeMeta ? activeMeta.label : ''}</h1>
          <div className="header-right">
            {activeTab === 'dashboard' && (
              <select className="form-control" style={{ width: 130 }} value={year}
                onChange={(e) => setYear(parseInt(e.target.value, 10))}>
                {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>FY {y}</option>)}
              </select>
            )}
            <span className={`badge ${online ? 'bg-green' : 'local'}`}><i className="fa-solid fa-circle"></i> {online ? 'Online' : 'Offline'}</span>
          </div>
        </header>
        <main className="page">
          <Page year={year} />
        </main>
      </div>
      <Toasts />
    </div>
  );
}
