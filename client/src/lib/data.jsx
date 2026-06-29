import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { api, setApiToken, setUnauthorizedHandler } from './api.js';
import { TABLES } from './helpers.js';
import { enqueue, flush, pendingCount } from './outbox.js';

const DataCtx = createContext(null);
export const useData = () => useContext(DataCtx);

export function DataProvider({ children }) {
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
    const list = Array.isArray(tables) ? tables : tables ? [tables] : TABLES;
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
  }, []);

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

  const checkoutPos = useCallback(async (payload) => {
    const res = await offlineWrite('pos', { ...payload, client_txn_id: crypto.randomUUID() }, ['salefront', 'materials', 'stocklog']);
    // Broadcast to other tabs
    if (res && !res.queued) {
      localStorage.setItem('KOTEA_SYNC_TRIGGER', String(Date.now()));
    }
    return res;
  }, [offlineWrite]);
  const submitExpense = useCallback(async (payload) => {
    const res = await offlineWrite('expense', { ...payload, client_txn_id: crypto.randomUUID() }, ['expenses', 'materials', 'stocklog']);
    // Broadcast to other tabs
    if (res && !res.queued) {
      localStorage.setItem('KOTEA_SYNC_TRIGGER', String(Date.now()));
    }
    return res;
  }, [offlineWrite]);

  // ---- Auth --------------------------------------------------------------
  const login = useCallback(async (username, password) => {
    const { token, user: u } = await api.login(username, password);
    setApiToken(token);
    localStorage.setItem('KOTEA_TOKEN', token);
    localStorage.setItem('KOTEA_USER', JSON.stringify(u));
    setUser(u);
    await reload();
    return u;
  }, [reload]);

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
    user, login, logout,
    theme, setTheme,
    toasts, pushToast,
    data, reload, insert, update, remove,
    checkoutPos, submitExpense,
    online, pending, sync,
    settings
  };

  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}
