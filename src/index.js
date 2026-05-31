import express from 'express';
import session from 'express-session';
import SqliteStore from 'better-sqlite3-session-store';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateConfig, env } from './config.js';
import { getDb } from './db.js';
import { requireAuth, ensureLocalAdmin, validateWebhookSecret } from './auth.js';
import apiRouter from './routes/api.js';
import authRouter from './routes/auth.js';
import { startPolling } from './watcher.js';

// Validate env vars before anything else
try {
  validateConfig();
} catch (err) {
  console.error('[startup] Config error:', err.message);
  process.exit(1);
}

// Init DB
const db = getDb();

// Ensure local admin exists on first run
await ensureLocalAdmin();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Sessions
const Store = SqliteStore(session);
app.use(session({
  store: new Store({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret: env.secretKey,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure:   env.appUrl.startsWith('https'),
    maxAge:   24 * 60 * 60 * 1000, // 24h default; overridden by setting at login time
  },
}));

// Webhook exemption (Tautulli can't do OIDC) — validate optional secret
app.post('/api/webhook', (req, res, next) => {
  if (!validateWebhookSecret(req)) {
    return res.status(401).json({ error: 'Invalid webhook token' });
  }
  next();
});

// Auth routes (login page, OIDC callbacks — no auth required)
app.use('/auth', authRouter);

// Everything else requires a session
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/webhook') return next();
  if (req.path === '/login') return next();
  return requireAuth(req, res, next);
});

// API
app.use('/api', apiRouter);

// Static UI
app.use(express.static(path.join(__dirname, 'public')));

// Login page
app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// SPA fallback — serve index.html for any unmatched GET
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(env.port, () => {
  console.log(`[server] Listening on http://0.0.0.0:${env.port}`);
  startPolling();
});
