// Shared formatting + small utilities.
//
// This file is now a re-export barrel: the implementations live in
// lib/format.js, lib/bom.js, lib/deliveryImport.js, and lib/modifiers.js
// (split by concern), kept re-exported here so existing imports across the
// app don't need to change. Constants with no natural sub-module of their
// own stay defined directly below.

export const TABLES = [
  'users', 'settings', 'materials', 'menuname', 'bom', 'childmenu', 'salefront', 'saledelivery',
  'stocklog', 'expenses', 'systemlog', 'customers', 'addons', 'packagingbom', 'matprepbom',
  'deliverydaily', 'deliverymenu', 'promotions', 'shifts', 'point_ledger', 'categories',
  'menu_modifiers'
];

// Transactional history tables that can grow unbounded. The Mother app's
// dashboards/reports need them in full; the POS/Expense satellites only need
// today's catalog + config, so they skip these on initial load (see
// DataProvider's `skipHeavyTables` prop) and fetch anything date-scoped
// on demand via the server's ?since/&until/&limit query support instead.
export const HEAVY_TABLES = [
  'salefront', 'saledelivery', 'stocklog', 'systemlog', 'expenses', 'deliverydaily', 'deliverymenu',
  'point_ledger' // POS looks balances up via api.pointsBalance instead
];

// Delivery GP is computed automatically as a fixed percentage of the base price.
export const DELIVERY_GP_RATE = 0.321;

export const THEMES = [
  { id: 'kopi-green', label: 'Kopi Olive', colors: ['oklch(52% 0.062 100)', 'oklch(43% 0.052 100)', 'oklch(93.5% 0.020 100)'] },
  { id: 'kopi-terracotta', label: 'Kopi Terracotta', colors: ['oklch(53% 0.135 40)', 'oklch(43% 0.12 38)', 'oklch(95% 0.035 40)'] },
  { id: 'kopi-blue', label: 'Kopi Blue', colors: ['oklch(52% 0.13 258)', 'oklch(42% 0.12 258)', 'oklch(95% 0.025 258)'] },
  { id: 'kopi-brown', label: 'Kopi Brown', colors: ['oklch(45% 0.08 55)', 'oklch(36% 0.07 52)', 'oklch(94% 0.025 55)'] }
];

export const PAGE_SIZE = 20;

// Shared claim-link/QR target for any point_ledger token (shop-issued link OR
// a POS receipt claim code) — always route through liff.line.me when a LIFF
// ID is configured: LINE resolves that URL straight to the LIFF app's
// registered Endpoint URL and handles login itself, so it works regardless of
// which raw domain customer.html is actually served from. Opening the raw
// domain URL directly (customer.html?claim=...) instead makes liff.login()'s
// redirect_uri include the query string, which LINE's login rejects with a
// 400 on some LIFF app configs — liff.line.me sidesteps that entirely.
// VITE_PORTAL_BASE + raw domain is only a fallback for local dev / setups
// with no LIFF ID yet (VITE_DEV_LINE_USER testing).
export const claimUrl = (token) => {
  const liffId = import.meta.env.VITE_LIFF_ID;
  if (liffId) return `https://liff.line.me/${liffId}?claim=${token}`;
  return `${(import.meta.env.VITE_PORTAL_BASE || window.location.origin).replace(/\/$/, '')}/customer.html?claim=${token}`;
};

// Parse a discount token like "10%" (percentage of base) or "15" (flat amount).
export function parseDiscount(token, base) {
  const t = token == null ? '' : String(token).trim();
  if (!t) return 0;
  if (t.endsWith('%')) {
    const pct = parseFloat(t.slice(0, -1)) || 0;
    return base * (pct / 100);
  }
  const flat = parseFloat(t);
  return isNaN(flat) ? 0 : flat;
}

export * from './format.js';
export * from './bom.js';
export * from './deliveryImport.js';
export * from './modifiers.js';
