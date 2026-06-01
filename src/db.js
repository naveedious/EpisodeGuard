import Database from 'better-sqlite3';
import path from 'path';
import { env } from './config.js';
import { emitLogEvent } from './events.js';

let db;

export function getDb() {
  if (!db) {
    db = new Database(path.join(env.dataDir, 'episode-guard.db'));
    db.pragma('journal_mode = WAL');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS oidc_providers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      issuer_url    TEXT    NOT NULL,
      client_id     TEXT    NOT NULL,
      client_secret TEXT    NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS oidc_allowed_users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL REFERENCES oidc_providers(id) ON DELETE CASCADE,
      subject     TEXT    NOT NULL,
      email       TEXT,
      name        TEXT,
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      UNIQUE(provider_id, subject)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      event_type    TEXT    NOT NULL,
      show_title    TEXT,
      season        INTEGER,
      episode       INTEGER,
      episode_count INTEGER,
      details       TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_ts   ON activity_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_activity_show ON activity_log(show_title);
  `);
}

// Settings

export const SETTING_DEFAULTS = {
  poll_interval_seconds: '300',
  lookahead_episodes:    '5',
  season_end_buffer:     '3',
  log_retention_days:    '90',
  apprise_url:           '',
  apprise_events:        'episode_grabbed',
  webhook_enabled:       '0',
  webhook_secret:        '',
  session_max_age_hours: '24',
};

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (SETTING_DEFAULTS[key] ?? null);
}

export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const result = { ...SETTING_DEFAULTS };
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export function setSettings(obj) {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const tx = getDb().transaction((entries) => {
    for (const [k, v] of entries) stmt.run(k, String(v));
  });
  tx(Object.entries(obj));
}

// Activity log

export function logEvent({ event_type, show_title, season, episode, episode_count, details }) {
  const row = getDb().prepare(`
    INSERT INTO activity_log (event_type, show_title, season, episode, episode_count, details)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    event_type,
    show_title    ?? null,
    season        ?? null,
    episode       ?? null,
    episode_count ?? null,
    details ? JSON.stringify(details) : null,
  );

  emitLogEvent(row);

  import('./notifications.js').then(({ sendAppriseNotification }) => {
    sendAppriseNotification(event_type, { showTitle: show_title, season, episode, details });
  }).catch(() => {});
}

export function getRecentActivity(limit = 100) {
  return getDb().prepare(
    'SELECT * FROM activity_log ORDER BY id DESC LIMIT ?'
  ).all(limit);
}

export function getActivityFiltered({ show, type, from, to, before } = {}, limit = 50, offset = 0) {
  const conditions = [];
  const params = [];

  if (show)   { conditions.push('show_title LIKE ?'); params.push('%' + show + '%'); }
  if (type)   { conditions.push('event_type = ?');    params.push(type); }
  if (from)   { conditions.push('timestamp >= ?');    params.push(from); }
  if (to)     { conditions.push('timestamp <= ?');    params.push(to); }
  if (before) { conditions.push('timestamp < ?');     params.push(before); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = getDb()
    .prepare('SELECT COUNT(*) as n FROM activity_log ' + where)
    .get(...params).n;

  const rows = getDb()
    .prepare('SELECT * FROM activity_log ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(...params, limit, offset);

  return { rows, total };
}

export function getDashboardStats() {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  const query = (whereClause) => db.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'episode_grabbed'  THEN COALESCE(episode_count, 1) ELSE 0 END) AS episodes_grabbed,
      SUM(CASE WHEN event_type = 'season_monitored' THEN 1                          ELSE 0 END) AS seasons_monitored,
      SUM(CASE WHEN event_type = 'episode_monitored' THEN COALESCE(episode_count, 1) ELSE 0 END) AS episodes_monitored
    FROM activity_log
    ${whereClause}
  `);

  return {
    allTime: query('').get(),
    last7d:  query("WHERE timestamp >= '" + sevenDaysAgo + "'").get(),
  };
}

// Auth helpers

export function getLocalUser(username) {
  return getDb().prepare('SELECT * FROM local_users WHERE username = ?').get(username);
}

export function createLocalUser(username, passwordHash) {
  return getDb().prepare('INSERT INTO local_users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
}

export function updateLocalUserPassword(username, passwordHash) {
  return getDb().prepare('UPDATE local_users SET password_hash = ? WHERE username = ?').run(passwordHash, username);
}

export function localUserCount() {
  return getDb().prepare('SELECT COUNT(*) as n FROM local_users').get().n;
}

export function getOidcProviders() {
  return getDb().prepare('SELECT * FROM oidc_providers ORDER BY id').all();
}

export function getOidcProvider(id) {
  return getDb().prepare('SELECT * FROM oidc_providers WHERE id = ?').get(id);
}

export function createOidcProvider({ name, issuer_url, client_id, client_secret, enabled = 1 }) {
  return getDb().prepare(
    'INSERT INTO oidc_providers (name, issuer_url, client_id, client_secret, enabled) VALUES (?, ?, ?, ?, ?)'
  ).run(name, issuer_url, client_id, client_secret, enabled ? 1 : 0);
}

export function updateOidcProvider(id, { name, issuer_url, client_id, client_secret, enabled }) {
  const fields = [];
  const vals = [];
  if (name        !== undefined) { fields.push('name = ?');          vals.push(name); }
  if (issuer_url  !== undefined) { fields.push('issuer_url = ?');    vals.push(issuer_url); }
  if (client_id   !== undefined) { fields.push('client_id = ?');     vals.push(client_id); }
  if (client_secret !== undefined) { fields.push('client_secret = ?'); vals.push(client_secret); }
  if (enabled     !== undefined) { fields.push('enabled = ?');       vals.push(enabled ? 1 : 0); }
  if (!fields.length) return;
  vals.push(id);
  return getDb().prepare(`UPDATE oidc_providers SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteOidcProvider(id) {
  return getDb().prepare('DELETE FROM oidc_providers WHERE id = ?').run(id);
}

export function getOidcAllowedUsers(providerId) {
  return getDb().prepare('SELECT * FROM oidc_allowed_users WHERE provider_id = ?').all(providerId);
}

export function getAllOidcAllowedUsers() {
  return getDb().prepare(`
    SELECT u.*, p.name as provider_name
    FROM oidc_allowed_users u
    JOIN oidc_providers p ON p.id = u.provider_id
    ORDER BY u.id
  `).all();
}

export function isOidcUserAllowed(providerId, subject) {
  return !!getDb().prepare('SELECT 1 FROM oidc_allowed_users WHERE provider_id = ? AND subject = ?').get(providerId, subject);
}

export function addOidcAllowedUser(providerId, { subject, email, name }) {
  return getDb().prepare(
    'INSERT OR IGNORE INTO oidc_allowed_users (provider_id, subject, email, name) VALUES (?, ?, ?, ?)'
  ).run(providerId, subject, email ?? null, name ?? null);
}

export function removeOidcAllowedUser(id) {
  return getDb().prepare('DELETE FROM oidc_allowed_users WHERE id = ?').run(id);
}

export function purgeOldLogs() {
  const days = parseInt(getSetting('log_retention_days'), 10);
  if (!days || days <= 0) return;

  const result = getDb()
    .prepare("DELETE FROM activity_log WHERE timestamp < datetime('now', '-' || ? || ' days')")
    .run(String(days));

  if (result.changes > 0) {
    console.log('[db] Purged ' + result.changes + ' log entries older than ' + days + ' days');
  }
}
