// ---- Auth ------------------------------------------------------------------
// Split out of index.js verbatim — behavior must stay byte-for-byte identical.
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool, updateRow, hashPassword, verifyPassword, verifyPin, logActivity } from '../db.js';
import { JWT_SECRET, TOKEN_TTL, PIN_RE, fail } from '../shared.js';
import { TABLES } from '../db.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

// Per-username PIN lockout, separate from the per-IP loginLimiter below. A
// POS is a single kiosk shared by every staff member all day, so limiting
// only by IP would let one person's mistyped PIN lock the whole shop out —
// this scopes the penalty to the one account instead. In-memory: fine for
// this hub's single-process deployment; would need a shared store (e.g.
// Redis) if it's ever run multi-instance behind a load balancer.
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;
const pinAttempts = new Map(); // username (lowercased) -> { count, lockedUntil }

function isPinLockedOut(username) {
  const entry = pinAttempts.get(String(username).toLowerCase());
  return !!(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
}
function recordFailedPinAttempt(username) {
  const key = String(username).toLowerCase();
  const entry = pinAttempts.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= PIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
    entry.count = 0;
  }
  pinAttempts.set(key, entry);
}
function clearFailedPinAttempts(username) {
  pinAttempts.delete(String(username).toLowerCase());
}

// Loose per-IP limiter — a second, weaker layer behind the per-username
// lockout above (which is what actually matters for a 4-digit keyspace).
// Kept generous because this IP is the one shared kiosk for the whole shop.
const pinLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this device. Please try again later.' }
});

// Public routes (mounted before the staff auth guard): login, staff-list, pin-login.
export function registerAuthRoutes(app) {
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username = '', password = '' } = req.body || {};
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
      const user = rows[0];
      const { ok, needsRehash } = await verifyPassword(password, user && user.password);
      if (!user || !ok) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      if (needsRehash) {
        await updateRow('users', user.username, { password: await hashPassword(password) });
      }
      await logActivity(user.username, 'User Login', `Logged in user: ${user.username}`);
      const { password: _pw, ...safe } = user;
      const token = jwt.sign(
        { username: safe.username, role: safe.role, access: safe.access },
        JWT_SECRET, { expiresIn: TOKEN_TTL }
      );
      // Seeded accounts ship with password == username (admin/admin). Flag them
      // so the client forces a password change before the app is usable.
      const mustChangePassword = String(password) === String(user.username);
      res.json({ token, user: safe, mustChangePassword });
    } catch (e) {
      fail(res, e);
    }
  });

  // Staff picker for the POS satellite app's PIN login screen — usernames
  // only, no roles/access/hashes. Public and unguarded like /api/auth/login;
  // the disclosure is limited to "these people work here", which staff on a
  // shared shop device already know about each other.
  app.get('/api/auth/staff-list', async (_req, res) => {
    try {
      const { rows } = await pool.query('SELECT username FROM users ORDER BY username');
      res.json(rows.map(r => r.username));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/auth/pin-login', pinLoginLimiter, async (req, res) => {
    const { username = '', pin = '' } = req.body || {};
    if (!username.trim() || !PIN_RE.test(pin)) {
      return res.status(401).json({ error: 'Invalid PIN.' });
    }
    if (isPinLockedOut(username)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username.trim()]);
      const user = rows[0];
      const ok = user && await verifyPin(pin, user.pin);
      if (!ok) {
        recordFailedPinAttempt(username);
        return res.status(401).json({ error: 'Invalid PIN.' });
      }
      clearFailedPinAttempts(username);
      await logActivity(user.username, 'User Login', `Logged in via PIN: ${user.username}`);
      const { password: _pw, pin: _pin, ...safe } = user;
      const token = jwt.sign(
        { username: safe.username, role: safe.role, access: safe.access },
        JWT_SECRET, { expiresIn: TOKEN_TTL }
      );
      res.json({ token, user: safe });
    } catch (e) {
      fail(res, e);
    }
  });
}

// Post-guard self-service routes: change-password, set-pin, tables list.
export function registerAccountRoutes(app) {
  // Self-service password change (any authenticated staff account). Used by the
  // forced-change flow when someone logs in with a default password.
  app.post('/api/auth/change-password', async (req, res) => {
    const { currentPassword = '', newPassword = '' } = req.body || {};
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    if (String(newPassword) === String(req.user.username)) {
      return res.status(400).json({ error: 'Password cannot be the same as the username.' });
    }
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.user.username]);
      const user = rows[0];
      const { ok } = await verifyPassword(currentPassword, user && user.password);
      if (!user || !ok) return res.status(401).json({ error: 'Current password is incorrect.' });
      await updateRow('users', user.username, { password: await hashPassword(newPassword) });
      await logActivity(user.username, 'PASSWORD CHANGE', 'User changed own password');
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  // Self-service PIN change/set — requires the account's own password (there's
  // no "current PIN" to check against on a first-time set, since pin starts
  // NULL). Same authenticated shape as change-password above.
  app.post('/api/auth/set-pin', async (req, res) => {
    const { currentPassword = '', newPin = '' } = req.body || {};
    if (!PIN_RE.test(newPin)) {
      return res.status(400).json({ error: 'PIN must be 4 digits.' });
    }
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [req.user.username]);
      const user = rows[0];
      const { ok } = await verifyPassword(currentPassword, user && user.password);
      if (!user || !ok) return res.status(401).json({ error: 'Current password is incorrect.' });
      await updateRow('users', user.username, { pin: await hashPassword(newPin) });
      await logActivity(user.username, 'PIN CHANGE', 'User changed own PIN');
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get('/api/tables', (_req, res) => res.json(TABLES));
}
