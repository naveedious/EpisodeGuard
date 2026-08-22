import { resolveLocalPath, probeMediaFile } from '../prober.js';
import { getEpisodeFile } from '../sonarr.js';
import fs from 'fs';
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
  const { show, type, from, to, before } = req.query;
  const limit  = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
  const page   = Math.max(parseInt(req.query.page  ?? '1',  10), 1);
  const offset = (page - 1) * limit;
  try {
    const result = getActivityFiltered({ show, type, from, to, before }, limit, offset);
    res.json({ rows: result.rows, total: result.total, page, limit, totalPages: Math.ceil(result.total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // stop nginx/proxy buffering so SSE streams immediately
  res.flushHeaders();

  // Seed with events from the last 10 minutes only
  const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recent = getActivityFiltered({ from: tenMinsAgo }, 200, 0).rows.reverse();
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
                   'webhook_secret','session_max_age_hours','integrity_check_mode',
                   'runtime_tolerance_percent','probe_tail_seconds','sonarr_path_prefix','local_path_prefix'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid settings provided' });

  const numerics = ['poll_interval_seconds','lookahead_episodes','season_end_buffer','log_retention_days','session_max_age_hours','runtime_tolerance_percent','probe_tail_seconds'];
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


router.post('/settings/test-integrity', async (req, res) => {
  const sonarrPrefix = req.body.sonarr_path_prefix || '/data/TV';
  const localPrefix = req.body.local_path_prefix || '/tv';
  const tolerancePercent = parseInt(req.body.runtime_tolerance_percent || '80', 10);
  const tailSeconds = parseInt(req.body.probe_tail_seconds || '30', 10);
  const customPath = req.body.custom_path ? req.body.custom_path.trim() : '';

  const steps = [];
  
  try {
    let sonarrPath = customPath;
    let expectedRuntimeSec = null;
    let sampleInfo = null;

    // Step 1: Resolve target file (from Sonarr or custom path)
    if (!sonarrPath) {
      // Query Sonarr for a recent series with files
      try {
        const seriesList = await (await import('../sonarr.js')).findSeriesByTitle('') || [];
        // Fallback: query /series directly if findSeriesByTitle('') returns null
        const allSeries = Array.isArray(seriesList) && seriesList.length ? seriesList : await (async () => {
          try {
            const { env } = await import('../config.js');
            const r = await fetch(env.sonarrUrl + '/api/v3/series', {
              headers: { 'X-Api-Key': env.sonarrApiKey }
            });
            return r.ok ? await r.json() : [];
          } catch { return []; }
        })();

        // Find a series with files on disk
        const targetSeries = allSeries.find(s => s.statistics && s.statistics.episodeFileCount > 0) || allSeries[0];
        
        if (targetSeries) {
          const { env } = await import('../config.js');
          const r = await fetch(`${env.sonarrUrl}/api/v3/episodefile?seriesId=${targetSeries.id}`, {
            headers: { 'X-Api-Key': env.sonarrApiKey }
          });
          if (r.ok) {
            const files = await r.json();
            if (Array.isArray(files) && files.length > 0) {
              const file = files[0];
              sonarrPath = file.path;
              sampleInfo = `${targetSeries.title} (${file.relativePath || file.sceneName || 'Episode'})`;
              if (file.mediaInfo && file.mediaInfo.runTime) {
                if (typeof file.mediaInfo.runTime === 'number') expectedRuntimeSec = file.mediaInfo.runTime * 60;
                else if (typeof file.mediaInfo.runTime === 'string') {
                  const parts = file.mediaInfo.runTime.split(':').map(Number);
                  if (parts.length === 3) expectedRuntimeSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
                  else if (parts.length === 2) expectedRuntimeSec = parts[0] * 60 + parts[1];
                }
              }
            }
          }
        }
      } catch (err) {
        steps.push({
          step: 'Sonarr File Query',
          status: 'warn',
          message: `Could not auto-select episode from Sonarr: ${err.message}`,
        });
      }
    }

    if (!sonarrPath) {
      steps.push({
        step: 'Target File Selection',
        status: 'error',
        message: 'No on-disk episodes found in Sonarr and no custom path provided to test.',
      });
      return res.json({ ok: false, steps });
    }

    steps.push({
      step: 'Target File',
      status: 'ok',
      message: sampleInfo ? `Selected sample: ${sampleInfo}` : 'Target path selected',
      detail: `Sonarr Path: ${sonarrPath}`,
    });

    // Step 2: Prefix mapping
    const localPath = resolveLocalPath(sonarrPath, sonarrPrefix, localPrefix);
    const mappingApplied = localPath !== sonarrPath;
    steps.push({
      step: 'Path Prefix Translation',
      status: 'ok',
      message: mappingApplied ? `Translated '${sonarrPrefix}' → '${localPrefix}'` : 'Path used as-is (prefix did not match or identical)',
      detail: `Container Local Path: ${localPath}`,
    });

    // Step 3: Container file accessibility and permissions check
    try {
      await fs.promises.access(localPath, fs.constants.R_OK);
      const stat = await fs.promises.stat(localPath);
      steps.push({
        step: 'Container Volume & Permissions',
        status: 'ok',
        message: `File is readable in container (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`,
        detail: `Local Path: ${localPath}`,
      });
    } catch (err) {
      steps.push({
        step: 'Container Volume & Permissions',
        status: 'error',
        message: `Container cannot read file: ${err.message}`,
        detail: `Check that your media volume mount (e.g. -v /host/path:${localPrefix}:ro) exists and is readable by uid 1000.`,
      });
      return res.json({ ok: false, steps, localPath, sonarrPath });
    }

    // Step 4: Run ffprobe & ffmpeg tail decode
    const probe = await probeMediaFile(localPath, {
      expectedRuntimeSec,
      tolerancePercent,
      tailSeconds,
      timeoutMs: 15000,
    });

    if (!probe.valid) {
      steps.push({
        step: 'Stream & Integrity Probe',
        status: 'error',
        message: `Integrity check failed: ${probe.reason} - ${probe.details}`,
        detail: `Probed duration: ${probe.actualDurationSec ? Math.round(probe.actualDurationSec) + 's' : 'unknown'}`,
      });
      return res.json({ ok: false, steps, probe, localPath, sonarrPath });
    }

    steps.push({
      step: 'Stream & Integrity Probe',
      status: 'ok',
      message: `ffprobe and ${tailSeconds}s ffmpeg tail decode passed cleanly (${Math.round(probe.actualDurationSec || 0)}s duration)`,
      detail: probe.details,
    });

    return res.json({ ok: true, steps, probe, localPath, sonarrPath });

  } catch (err) {
    steps.push({
      step: 'Test Execution',
      status: 'error',
      message: `Unexpected test failure: ${err.message}`,
    });
    return res.json({ ok: false, steps });
  }
});

export default router;
