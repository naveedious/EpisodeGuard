import crypto from 'crypto';
import {
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
  randomState,
  randomNonce,
  ClientSecretBasic,
} from 'openid-client';
import { env } from './config.js';
import {
  getLocalUser, createLocalUser, localUserCount,
  getOidcProviders, getOidcProvider,
  getSetting,
} from './db.js';
import bcrypt from 'bcryptjs';

// ── Encryption helpers ────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';

function deriveKey() {
  return crypto.createHash('sha256').update(env.secretKey).digest();
}

export function encrypt(text) {
  const iv     = crypto.randomBytes(12);
  const key    = deriveKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

export function decrypt(payload) {
  const [ivHex, tagHex, encHex] = payload.split(':');
  const key     = deriveKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// ── First-run local admin ─────────────────────────────────────────────────────

export async function ensureLocalAdmin() {
  if (localUserCount() > 0) return;

  const tempPassword = crypto.randomBytes(12).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 12);
  createLocalUser('admin', hash);

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║         EPISODE GUARD — FIRST RUN SETUP          ║');
  console.log('║                                                    ║');
  console.log('║  Local admin account created.                     ║');
  console.log(`║  Username: admin                                  ║`);
  console.log(`║  Password: ${tempPassword.padEnd(38)}║`);
  console.log('║                                                    ║');
  console.log('║  Change this password in Settings after login.    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
}

// ── Local auth ────────────────────────────────────────────────────────────────

export async function verifyLocalCredentials(username, password) {
  const user = getLocalUser(username);
  if (!user) return false;
  return bcrypt.compare(password, user.password_hash);
}

// ── OIDC client config cache (openid-client v6) ───────────────────────────────

const configCache = new Map();

export async function getOidcConfig(providerId) {
  if (configCache.has(providerId)) return configCache.get(providerId);

  const row = getOidcProvider(providerId);
  if (!row || !row.enabled) return null;

  try {
    const config = await discovery(
      new URL(row.issuer_url),
      row.client_id,
      { client_secret: decrypt(row.client_secret) },
      ClientSecretBasic(decrypt(row.client_secret)),
    );
    configCache.set(providerId, config);
    return config;
  } catch (err) {
    console.error(`[auth] OIDC discovery failed for provider ${providerId}:`, err.message);
    return null;
  }
}

export function invalidateOidcConfigCache(providerId) {
  if (providerId) configCache.delete(providerId);
  else configCache.clear();
}

// Build authorization URL for a provider
export async function buildOidcAuthUrl(config, providerId) {
  const codeVerifier    = randomPKCECodeVerifier();
  const codeChallenge   = await calculatePKCECodeChallenge(codeVerifier);
  const state           = randomState();
  const nonce           = randomNonce();
  const redirectUri     = `${env.appUrl}/auth/callback/${providerId}`;

  const url = buildAuthorizationUrl(config, {
    redirect_uri:          redirectUri,
    scope:                 'openid email profile',
    state,
    nonce,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: url.href, state, nonce, codeVerifier, redirectUri };
}

// Exchange code for tokens and return claims
export async function handleOidcCallback(config, currentUrl, checks) {
  const tokens = await authorizationCodeGrant(config, new URL(currentUrl), {
    expectedState:    checks.state,
    expectedNonce:    checks.nonce,
    pkceCodeVerifier: checks.codeVerifier,
  });
  return tokens.claims();
}

// ── Auth middleware ───────────────────────────────────────────────────────────

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

// ── OIDC availability check ───────────────────────────────────────────────────

export function hasOidcProviders() {
  return getOidcProviders().some(p => p.enabled);
}

// ── Webhook secret validation ─────────────────────────────────────────────────

export function validateWebhookSecret(req) {
  const secret = getSetting('webhook_secret');
  if (!secret) return true; // not configured — allow all
  return req.headers['x-webhook-token'] === secret;
}
