import { Router } from 'express';
import { createRequire } from 'module';
import { getAllSettings, setSettings, getDashboardStats, getRecentActivity, getActivityFiltered } from '../db.js';
import { getPlayingEpisodes } from '../tautulli.js';
import { getJellyfinSessions } from '../jellyfin.js';
import { state, restartPolling, handleWebhookTrigger } from '../watcher.js';
import { addSseClient, removeSseClient } from '../events.js';
import { sources } from '../config.js';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../../package.json');
const version = process.env.APP_VERSION || pkgVersion;

const router = Router();

router.get('/version', (req, res) => {
  res.json({ version });
});

router.get('/status', (req, res) => {
  res.json({
    lastPollAt: state.lastPollAt, nextPollAt: state.nextPollAt,
    isRunning: state.isRunning, lastError: state.lastError, webhookEnabled: state.webhookEnabled,
    lastWebhookAt: state.lastWebhookAt,
  });
});

router.get('/dashboard', async (req, res) => {
  try {
    const nowPlayingFetchers = [];
    if (sources.tautulli) nowPlayingFetchers.push(getPlayingEpisodes().catch(() => []));
    if (sources.jellyfin)  nowPlayingFetchers.push(getJellyfinSessions().catch(() => []));

    const [stats, activity, ...nowPlayingSources] = await Promise.all([
      Promise.resolve(getDashboardStats()),
      Promise.resolve(getRecentActivity(50)),
      ...nowPlayingFetchers,
    ]);

    const seen = new Set();
    const nowPlaying = nowPlayingSources.flat().filter(ep => {
      const key = ep.showTitle + '-S' + ep.season + 'E' + ep.episode;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ stats, activity, nowPlaying, status: {
      lastPollAt: state.lastPollAt, nextPollAt: state.nextPollAt,
      isRunning: state.isRunning, lastError: state.lastError, webhookEnabled: state.webhookEnabled,
    }});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/logs', (req, res) => {
  const { show, type, from, to } = req.query;
  const limit  = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const page   = Math.max(parseInt(req.query.page  ?? '1',  10), 1);
  const offset = (page - 1) * limit;
  try {
    const result = getActivityFiltered({ show, type, from, to }, limit, offset);
    res.json({ rows: result.rows, total: result.total, page, limit, totalPages: Math.ceil(result.total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const recent = getRecentActivity(20).reverse();
  for (const row of recent) res.write('data: ' + JSON.stringify(row) + '\n\n');

  addSseClient(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 30000);

  req.on('close', () => { clearInterval(ping); removeSseClient(res); });
});

router.post('/webhook', async (req, res) => {
  const body = req.body;

  // Detect source from payload shape:
  // Tautulli sends grandparent_guids; Jellyfin sends SeriesName + ParentIndexNumber
  const isJellyfin = body.SeriesName !== undefined || body.NotificationType !== undefined;

  let showTitle, season, episode, tvdbId, source;

  if (isJellyfin) {
    // Jellyfin webhook plugin payload
    if (body.ItemType !== 'Episode') return res.json({ ok: true, skipped: 'not an episode' });
    showTitle = body.SeriesName ?? '';
    season    = parseInt(body.SeasonNumber ?? body.ParentIndexNumber ?? '0', 10);
    episode   = parseInt(body.EpisodeNumber ?? body.IndexNumber ?? '0', 10);
    tvdbId    = body.Provider_tvdb ? parseInt(body.Provider_tvdb, 10) : null;
    source    = 'jellyfin';
  } else {
    // Tautulli payload
    const mediaType = body.media_type ?? body.mediaType;
    if (mediaType !== 'episode') return res.json({ ok: true, skipped: 'not an episode' });
    showTitle = body.grandparent_title ?? body.show_name ?? '';
    season    = parseInt(body.parent_media_index ?? body.season_num  ?? '0', 10);
    episode   = parseInt(body.media_index        ?? body.episode_num ?? '0', 10);
    tvdbId    = parseTvdbId(body.grandparent_guids ?? []);
    source    = 'tautulli';
  }

  if (!showTitle || !season || !episode) {
    return res.status(400).json({ error: 'Missing required fields: show title, season, episode' });
  }

  const ep = { sessionKey: 'webhook-' + Date.now(), showTitle, season, episode, tvdbId, source };

  console.log('[webhook] Received (' + source + '): show=' + showTitle + ' S' + String(season).padStart(2,'0') + 'E' + String(episode).padStart(2,'0') + ' tvdbId=' + tvdbId);

  res.json({ ok: true, received: { showTitle, season, episode, tvdbId, source } });
  handleWebhookTrigger(ep).catch(err => console.error('[webhook] Processing error:', err.message));
});

function parseTvdbId(guids) {
  if (!Array.isArray(guids)) return null;
  for (const g of guids) {
    const m = String(g).match(/^tvdb:\/\/(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

router.get('/settings', (req, res) => { res.json(getAllSettings()); });

router.post('/settings', (req, res) => {
  const allowed = ['poll_interval_seconds','lookahead_episodes','season_end_buffer',
                   'log_retention_days','apprise_url','apprise_events','webhook_enabled',
                   'webhook_secret','session_max_age_hours'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid settings provided' });

  const numerics = ['poll_interval_seconds','lookahead_episodes','season_end_buffer','log_retention_days','session_max_age_hours'];
  for (const key of numerics) {
    if (updates[key] !== undefined) {
      const n = parseInt(updates[key], 10);
      if (isNaN(n) || n < 1) return res.status(400).json({ error: key + ' must be a positive integer' });
      updates[key] = String(n);
    }
  }

  if (updates.webhook_enabled !== undefined) {
    updates.webhook_enabled = (updates.webhook_enabled === '1' || updates.webhook_enabled === true || updates.webhook_enabled === 'true') ? '1' : '0';
  }

  setSettings(updates);
  if (updates.poll_interval_seconds || updates.webhook_enabled !== undefined) restartPolling();
  res.json({ ok: true, settings: getAllSettings() });
});

export default router;
