import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { api, setApiToken, setUnauthorizedHandler } from './api.js';
import { TABLES, HEAVY_TABLES } from './helpers.js';
import { enqueue, flush, pendingCount } from './outbox.js';

const DataCtx = createContext(null);
export const useData = () => useContext(DataCtx);

// skipHeavyTables: the POS/Expense satellites only need today's catalog +
// config to run, not the full transactional history — they pass this to skip
// salefront/expenses/etc. on login and any reload() call with no explicit
// table list. Pages that DO need that history (Mother's dashboards/reports)
// fetch it themselves via reload(['salefront']) or the windowed api.list().
export function DataProvider({ children, skipHeavyTables = false }) {
  // Stable reference (skipHeavyTables never changes post-mount) so reload's
  // useCallback below can safely depend on it without invalidating every render.
  const defaultTables = useMemo(
    () => (skipHeavyTables ? TABLES.filter(t => !HEAVY_TABLES.includes(t)) : TABLES),
    [skipHeavyTables]
  );
  const [user, setUser] = useState(null);
  const [theme, setThemeState] = useState(localStorage.getItem('KOTEA_THEME') || 'kopi-green');
  const [data, setData] = useState(() => Object.fromEntries(TABLES.map(t => [t, []])));
  const [toasts, setToasts] = useState([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(pendingCount());
  const toastId = useRef(0);

  // ---- Theme -------------------------------------------------------------
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const setTheme = useCallback((t) => {
    setThemeState(t);
    localStorage.setItem('KOTEA_THEME', t);
  }, []);

  // ---- Toasts ------------------------------------------------------------
  const pushToast = useCallback((message, type = 'info') => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }, []);

  // ---- Data loading ------------------------------------------------------
  // Each table is cached to localStorage on success, so the catalog (menu, BOM,
  // materials…) is still available to POS when the device is offline.
  const cacheKey = (t) => 'KOTEA_CACHE_' + t;
  const reload = useCallback(async (tables) => {
    const list = Array.isArray(tables) ? tables : tables ? [tables] : defaultTables;
    const results = await Promise.all(list.map(t =>
      api.list(t)
        .then(rows => { try { localStorage.setItem(cacheKey(t), JSON.stringify(rows)); } catch {} return rows; })
        .catch(() => { try { return JSON.parse(localStorage.getItem(cacheKey(t)) || '[]'); } catch { return []; } })
    ));
    setData(prev => {
      const next = { ...prev };
      list.forEach((t, i) => { next[t] = results[i]; });
      return next;
    });
  }, [defaultTables]);

  // ---- Offline sync ------------------------------------------------------
  const sync = useCallback(async () => {
    const n = await flush();
    setPending(pendingCount());
    if (n) await reload();
    return n;
  }, [reload]);

  useEffect(() => {
    const goOnline = () => { setOnline(true); sync(); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, [sync]);

  // ---- Cross-tab sync (reload when other tabs sync) ----------------------
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'KOTEA_SYNC_TRIGGER') {
        reload();
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [reload]);

  // Offline-first writes: try the server; if the network is unreachable, queue
  // the write and resolve optimistically. A server response (e.g. 409 out of
  // stock) is a real error and is re-thrown for the caller to handle.
  const offlineWrite = useCallback(async (kind, body, affected) => {
    if (navigator.onLine) {
      try {
        const res = await api[kind === 'pos' ? 'checkoutPos' : 'expense'](body);
        // Reload in background without blocking the response
        reload(affected);
        return res;
      } catch (e) { if (e.status) throw e; } // reached the server → not a connectivity issue
    }
    enqueue(kind, body);
    setPending(pendingCount());
    return { queued: true };
  }, [reload]);

  // salefront/expenses are only pulled back into shared state for apps that
  // actually display that history (Mother) — POS/Expense already show their
  // own result via the checkout/expense response and refresh stock locally.
  const checkoutPos = useCallback(async (payload) => {
    const affected = skipHeavyTables ? ['materials', 'stocklog'] : ['salefront', 'materials', 'stocklog'];
    const res = await offlineWrite('pos', { ...payload, client_txn_id: crypto.randomUUID() }, affected);
    // Broadcast to other tabs
    if (res && !res.queued) {
      localStorage.setItem('KOTEA_SYNC_TRIGGER', String(Date.now()));
    }
    return res;
  }, [offlineWrite, skipHeavyTables]);
  const submitExpense = useCallback(async (payload) => {
    const affected = skipHeavyTables ? ['materials', 'stocklog'] : ['expenses', 'materials', 'stocklog'];
    const res = await offlineWrite('expense', { ...payload, client_txn_id: crypto.randomUUID() }, affected);
    // Broadcast to other tabs
    if (res && !res.queued) {
      localStorage.setItem('KOTEA_SYNC_TRIGGER', String(Date.now()));
    }
    return res;
  }, [offlineWrite, skipHeavyTables]);

  // ---- Auth --------------------------------------------------------------
  const login = useCallback(async (username, password) => {
    const { token, user: rawUser, mustChangePassword } = await api.login(username, password);
    // mustChangePassword (default password detected) gates the whole app via
    // the ChangePassword screen until a real password is set.
    const u = { ...rawUser, mustChangePassword: !!mustChangePassword };
    setApiToken(token);
    localStorage.setItem('KOTEA_TOKEN', token);
    localStorage.setItem('KOTEA_USER', JSON.stringify(u));
    setUser(u);
    await reload();
    return u;
  }, [reload]);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    await api.changePassword(currentPassword, newPassword);
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, mustChangePassword: false };
      localStorage.setItem('KOTEA_USER', JSON.stringify(next));
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    setApiToken('');
    localStorage.removeItem('KOTEA_TOKEN');
    localStorage.removeItem('KOTEA_USER');
    setUser(null);
  }, []);

  // Restore a previous session (if any) on first load.
  useEffect(() => {
    setUnauthorizedHandler(logout);
    const token = localStorage.getItem('KOTEA_TOKEN');
    const savedUser = localStorage.getItem('KOTEA_USER');
    if (token && savedUser) {
      setApiToken(token);
      setUser(JSON.parse(savedUser));
      reload().then(sync).catch(logout); // drain anything queued from a past offline session
    }
  }, [reload, logout, sync]);

  // ---- Write helpers (reload affected table afterwards) ------------------
  const insert = useCallback(async (table, obj, extra = []) => {
    const row = await api.insert(table, obj);
    await reload([table, ...extra]);
    return row;
  }, [reload]);

  const update = useCallback(async (table, id, obj, extra = []) => {
    const row = await api.update(table, id, obj);
    await reload([table, ...extra]);
    return row;
  }, [reload]);

  const remove = useCallback(async (table, id, extra = []) => {
    await api.remove(table, id);
    await reload([table, ...extra]);
  }, [reload]);

  const settings = data.settings[0] || {};

  const value = {
    user, login, logout, changePassword,
    theme, setTheme,
    toasts, pushToast,
    data, reload, insert, update, remove,
    checkoutPos, submitExpense,
    online, pending, sync,
    settings
  };

  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}
