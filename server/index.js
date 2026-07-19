// SMA V08 - Express API hub (Supabase Postgres) for the Mother + POS/Expense satellite apps
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initDb } from './db.js';
import { registerLineExpenseRoutes } from './lineExpense.js';
import { staffAuthGuard } from './shared.js';
import { registerAuthRoutes, registerAccountRoutes } from './routes/auth.js';
import { registerCustomerPortalRoutes } from './routes/customerPortal.js';
import { registerLineSlipsRoutes } from './routes/lineSlips.js';
import { registerPointsRoutes } from './routes/points.js';
import { registerCheckoutRoutes } from './routes/checkout.js';
import { registerDeliveryRoutes } from './routes/delivery.js';
import { registerShiftRoutes } from './routes/shifts.js';
import { registerAdminOpsRoutes } from './routes/adminOps.js';
import { registerCrudRoutes } from './routes/crud.js';

try {
  await initDb();
} catch (e) {
  // A bad DATABASE_URL or unreachable DB used to hang here forever with no
  // log output at all ("no open ports detected"). Fail loud instead.
  console.error('FATAL: could not connect to the database.', e.message);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

const app = express();
// Render (and most PaaS hosts) sit one reverse-proxy hop in front of us, so
// req.ip / X-Forwarded-For need this to resolve the real client IP — without
// it, express-rate-limit's login limiter can't safely key by IP.
app.set('trust proxy', 1);

// Security headers (X-Frame-Options, X-Content-Type-Options, HSTS, etc).
// CSP is left off deliberately: the client pages pull from several external
// origins helmet's default policy would block — Google Fonts (fonts.googleapis.com
// / fonts.gstatic.com), Font Awesome (cdnjs.cloudflare.com), the LINE LIFF SDK
// (static.line-scdn.net, customer.html), a dynamic import of the Supabase JS
// client (esm.sh, Settings.jsx cloud-sync), and — since that cloud-sync feature
// lets a user paste in *any* Supabase project URL — a whitelist can't cover
// connect-src at all. Revisit if that Supabase sync feature is ever removed.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS: allow all origins by default (fine when the client is served by this
// same server). Set CORS_ORIGIN (comma-separated) to restrict in production.
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : true;
app.use(cors({ origin: corsOrigins }));
// The LINE Messaging API webhook signs the exact raw request bytes
// (x-line-signature = HMAC-SHA256 over the body), so stash the raw buffer for
// that one path — parsed-then-restringified JSON wouldn't verify.
app.use(express.json({
  limit: '25mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl.startsWith('/api/line/webhook')) req.rawBody = buf;
  }
}));

// Serve the built client (if present) and fall back to it for client-side routing.
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
}

// General ceiling on top of the stricter per-route limiters below (login,
// etc). Generous enough for a shop's own registers bursting behind one NAT'd
// IP, tight enough to blunt a scripted flood against the whole API surface.
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api', apiLimiter);

// Keep-alive / cold-start guard. Public (no auth), mounted above every guard.
// The customer portal (customer.html) pings this while it's open, and an
// external cron (cron-job.org, every ~10-14 min) hits it around the clock so
// the free-tier host (Render) never spins down and Supabase never pauses from
// inactivity. The lightweight `SELECT 1` is what creates the DB activity that
// keeps the database out of deep sleep — a bare 200 wouldn't touch Postgres.
app.get('/api/ping', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, ts: Date.now() });
  } catch (e) {
    // Express itself is awake (that's half the point of the ping); only the DB
    // is unreachable. Report it without leaking driver internals.
    console.error('ping: database unreachable', e.message);
    res.status(503).json({ ok: false });
  }
});

// ---- Public routes (own auth, mounted before the staff guard) -------------
registerAuthRoutes(app);          // login, staff-list, pin-login
registerCustomerPortalRoutes(app); // /api/customer/*
registerLineSlipsRoutes(app);      // /api/line/slips* (Make.com automation)
// In-chat LINE expense bot (send a receipt photo / text to the OA, pick items
// to record, all inside LINE chat). Mounted before the staff guard below —
// LINE's webhook carries no JWT; it authenticates with x-line-signature.
// See server/lineExpense.js.
registerLineExpenseRoutes(app);

// All routes below require a valid STAFF token. Customer tokens are rejected
// here so they can't reach the generic CRUD / checkout routes.
app.use('/api', staffAuthGuard);

// ---- Staff-only routes ------------------------------------------------------
registerAccountRoutes(app);   // change-password, set-pin, tables
registerPointsRoutes(app);    // points/*, salefront void, redemption/*
registerCheckoutRoutes(app);  // checkout/*, expense
registerDeliveryRoutes(app);  // import/delivery
registerShiftRoutes(app);     // shift/*
registerAdminOpsRoutes(app);  // backup/restore
registerCrudRoutes(app);      // generic /api/:table (registered last so specific routes take priority)

// Multi-page SPA fallback: each satellite app gets its own HTML shell;
// all other non-API routes fall back to the Mother app (index.html).
if (fs.existsSync(CLIENT_DIST)) {
  const distFile = (name) => path.join(CLIENT_DIST, name);
  app.get('/pos.html', (_req, res) => res.sendFile(distFile('pos.html')));
  app.get('/expense.html', (_req, res) => res.sendFile(distFile('expense.html')));
  app.get('/customer.html', (_req, res) => res.sendFile(distFile('customer.html')));
  app.get('/expense-review.html', (_req, res) => res.sendFile(distFile('expense-review.html')));
  // If LINE LIFF redirects back to root with liff.state param, forward to the portal.
  app.get('/', (req, res) => {
    if ('liff.state' in req.query) {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect(302, `/customer.html?${qs}`);
    }
    res.sendFile(distFile('index.html'));
  });
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(distFile('index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`SMA V08 hub API running on http://localhost:${PORT}`));
