import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateConfig, env } from './config.js';
import { getDb } from './db.js';
import { basicAuth } from './auth.js';
import apiRouter from './routes/api.js';
import { startPolling } from './watcher.js';

// Validate env vars before anything else
try {
  validateConfig();
} catch (err) {
  console.error('[startup] Config error:', err.message);
  process.exit(1);
}

// Init DB
getDb();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// All routes require basic auth except the webhook (Tautulli can't send credentials)
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/webhook') return next();
  return basicAuth(req, res, next);
});

// API
app.use('/api', apiRouter);

// Static UI
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any unmatched GET
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(env.port, () => {
  console.log(`[server] Listening on http://0.0.0.0:${env.port}`);
  startPolling();
});
