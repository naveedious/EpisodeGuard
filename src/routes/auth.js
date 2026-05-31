import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  getOidcProviders, getOidcProvider,
  getLocalUser, updateLocalUserPassword, localUserCount,
  createOidcProvider, updateOidcProvider, deleteOidcProvider,
  getAllOidcAllowedUsers, isOidcUserAllowed, addOidcAllowedUser, removeOidcAllowedUser,
  getSetting,
} from '../db.js';
import {
  verifyLocalCredentials,
  getOidcConfig, invalidateOidcConfigCache,
  buildOidcAuthUrl, handleOidcCallback,
  requireAuth, encrypt,
} from '../auth.js';

const router = Router();

// ── Local login ───────────────────────────────────────────────────────────────

router.post('/local', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const ok = await verifyLocalCredentials(username, password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.user = { type: 'local', username };
      req.session.cookie.maxAge = parseInt(getSetting('session_max_age_hours') ?? '24', 10) * 3600 * 1000;
      req.session.save(() => res.json({ ok: true }));
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OIDC — initiate ───────────────────────────────────────────────────────────

router.get('/oidc/:providerId', async (req, res) => {
  const providerId = parseInt(req.params.providerId, 10);

  try {
    const config = await getOidcConfig(providerId);
    if (!config) return res.redirect('/login?error=provider_unavailable');

    const { url, state, nonce, codeVerifier, redirectUri } = await buildOidcAuthUrl(config, providerId);

    req.session.oidcState = { state, nonce, codeVerifier, redirectUri, providerId };
    req.session.save(() => res.redirect(url));
  } catch (err) {
    console.error('[auth] OIDC initiate error:', err.message);
    res.redirect('/login?error=provider_unavailable');
  }
});

// ── OIDC — callback ───────────────────────────────────────────────────────────

router.get('/callback/:providerId', async (req, res) => {
  const providerId = parseInt(req.params.providerId, 10);
  const saved = req.session.oidcState;

  if (!saved || saved.providerId !== providerId) {
    return res.redirect('/login?error=invalid_state');
  }

  try {
    const config = await getOidcConfig(providerId);
    if (!config) return res.redirect('/login?error=provider_unavailable');

    const currentUrl = `${saved.redirectUri}?${new URLSearchParams(req.query).toString()}`;

    const claims = await handleOidcCallback(config, currentUrl, {
      state:        saved.state,
      nonce:        saved.nonce,
      codeVerifier: saved.codeVerifier,
    });

    const subject = claims.sub;

    if (!isOidcUserAllowed(providerId, subject)) {
      console.warn(`[auth] OIDC login denied — subject not in allow list: provider=${providerId} sub=${subject}`);
      return res.redirect('/login?error=not_allowed');
    }

    delete req.session.oidcState;

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?error=session_error');
      req.session.user = {
        type:       'oidc',
        providerId,
        subject,
        email:      claims.email,
        name:       claims.name,
      };
      req.session.cookie.maxAge = parseInt(getSetting('session_max_age_hours') ?? '24', 10) * 3600 * 1000;
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) {
    console.error('[auth] OIDC callback error:', err.message);
    res.redirect('/login?error=oidc_error');
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ── Whoami ────────────────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Unauthenticated' });
  res.json(req.session.user);
});

// ── Provider list (public — needed for login page) ────────────────────────────

router.get('/providers', (req, res) => {
  const providers = getOidcProviders()
    .filter(p => p.enabled)
    .map(({ id, name }) => ({ id, name })); // never expose secrets
  res.json({ providers, hasLocal: localUserCount() > 0 });
});

// ── Admin routes — require auth ───────────────────────────────────────────────

router.use(requireAuth);

// Change local password
router.post('/local/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const username = req.session.user?.username;
  if (!username) return res.status(403).json({ error: 'Only local users can change password here' });

  const ok = await verifyLocalCredentials(username, currentPassword);
  if (!ok) return res.status(401).json({ error: 'Current password incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  updateLocalUserPassword(username, hash);
  res.json({ ok: true });
});

// OIDC provider CRUD
router.get('/admin/providers', (req, res) => {
  const rows = getOidcProviders().map(p => ({
    ...p,
    client_secret: '••••••••', // never expose
  }));
  res.json(rows);
});

router.post('/admin/providers', (req, res) => {
  const { name, issuer_url, client_id, client_secret, enabled } = req.body ?? {};
  if (!name || !issuer_url || !client_id || !client_secret) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const result = createOidcProvider({
    name, issuer_url, client_id,
    client_secret: encrypt(client_secret),
    enabled: enabled !== false,
  });
  invalidateOidcConfigCache();
  res.json({ id: result.lastInsertRowid });
});

router.put('/admin/providers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, issuer_url, client_id, client_secret, enabled } = req.body ?? {};
  const update = { name, issuer_url, client_id, enabled };
  if (client_secret && client_secret !== '••••••••') {
    update.client_secret = encrypt(client_secret);
  }
  updateOidcProvider(id, update);
  invalidateOidcConfigCache(id);
  res.json({ ok: true });
});

router.delete('/admin/providers/:id', (req, res) => {
  deleteOidcProvider(parseInt(req.params.id, 10));
  invalidateOidcConfigCache();
  res.json({ ok: true });
});

// OIDC allowed users
router.get('/admin/allowed-users', (req, res) => {
  res.json(getAllOidcAllowedUsers());
});

router.post('/admin/allowed-users', (req, res) => {
  const { provider_id, subject, email, name } = req.body ?? {};
  if (!provider_id || !subject) return res.status(400).json({ error: 'provider_id and subject required' });
  addOidcAllowedUser(provider_id, { subject, email, name });
  res.json({ ok: true });
});

router.delete('/admin/allowed-users/:id', (req, res) => {
  removeOidcAllowedUser(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

export default router;
