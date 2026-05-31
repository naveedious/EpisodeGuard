import { getPlayingEpisodes, getRecentlyWatchedEpisodes } from './tautulli.js';
import {
  findSeriesByTvdbId,
  getTwoSeasonEpisodes,
  ensureUpcomingEpisodes,
  checkSeasonEndAndPreload,
} from './sonarr.js';
import { getSetting, logEvent, purgeOldLogs } from './db.js';

export const state = {
  lastPollAt:     null,
  nextPollAt:     null,
  isRunning:      false,
  lastError:      null,
  webhookEnabled: false,
  lastWebhookAt:  null,
};

const processed = new Map();
// Episodes recently processed by webhook: key -> timestamp ms. Dedupes poll.
const webhookDeduped = new Map();
const WEBHOOK_DEDUP_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — covers any episode length
let pollTimer = null;

export function startPolling() {
  const webhookEnabled = getSetting('webhook_enabled') === '1';
  state.webhookEnabled = webhookEnabled;
  const defaultInterval = webhookEnabled ? 600 : 300;
  const intervalMs = parseInt(getSetting('poll_interval_seconds') || String(defaultInterval), 10) * 1000;
  console.log('[watcher] Starting - poll every ' + (intervalMs / 1000) + 's' + (webhookEnabled ? ' (webhook active, polling as fallback)' : ''));
  state.isRunning = true;
  scheduleNext(intervalMs, true);
}

export function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  state.isRunning = false;
}

export function restartPolling() {
  console.log('[watcher] Restarting with new settings');
  stopPolling();
  startPolling();
}

export async function handleWebhookTrigger(ep) {
  const { showTitle, season, episode, tvdbId } = ep;
  const label = '"' + showTitle + '" S' + pad(season) + 'E' + pad(episode);
  console.log('[watcher] Webhook trigger: ' + label);
  state.lastWebhookAt = new Date().toISOString();
  const dedupKey = showTitle + '-S' + pad(season) + 'E' + pad(episode);
  webhookDeduped.set(dedupKey, Date.now());
  logEvent({ event_type: 'webhook_received', show_title: showTitle, season, episode,
    details: { message: 'Received via webhook', trigger: 'webhook', tvdbId } });
  try {
    const series = tvdbId ? await findSeriesByTvdbId(tvdbId) : null;
    if (!series) {
      console.warn('[watcher] ' + label + ' not found in Sonarr (webhook) - skipping');
      logEvent({ event_type: 'error', show_title: showTitle, season, episode,
        details: { message: 'Show not found in Sonarr', trigger: 'webhook', tvdbId } });
      return;
    }
    await processEpisode(ep, series, 'webhook');
  } catch (err) {
    console.error('[watcher] Webhook error for ' + label + ':', err.message);
    logEvent({ event_type: 'error', show_title: showTitle, season, episode, details: { message: err.message, trigger: 'webhook' } });
  }
}

function scheduleNext(intervalMs, runNow = false) {
  if (runNow) runWatcher();
  state.nextPollAt = new Date(Date.now() + intervalMs).toISOString();
  pollTimer = setInterval(() => {
    runWatcher();
    state.nextPollAt = new Date(Date.now() + intervalMs).toISOString();
  }, intervalMs);
}

async function runWatcher() {
  state.lastPollAt = new Date().toISOString();
  console.log('[watcher] Poll - ' + state.lastPollAt);

  try { purgeOldLogs(); } catch (err) { console.error('[watcher] Log purge error:', err.message); }

  const webhookEnabled = getSetting('webhook_enabled') === '1';
  state.webhookEnabled = webhookEnabled;

  let episodes;
  try {
    if (webhookEnabled) {
      episodes = await getPlayingEpisodes();
    } else {
      const [playing, recent] = await Promise.all([
        getPlayingEpisodes(),
        getRecentlyWatchedEpisodes(parseInt(getSetting('poll_interval_seconds'), 10) * 2),
      ]);
      const seen = new Set(playing.map(e => e.showTitle + '-S' + e.season + 'E' + e.episode));
      const uniqueRecent = recent.filter(e => !seen.has(e.showTitle + '-S' + e.season + 'E' + e.episode));
      episodes = [...playing, ...uniqueRecent];
    }
  } catch (err) {
    state.lastError = err.message;
    console.error('[watcher] Tautulli error:', err.message);
    return;
  }

  if (!episodes.length) {
    console.log('[watcher] No TV episodes to process');
    return;
  }

  const activeSessions = new Set(episodes.map(e => e.sessionKey));

  for (const ep of episodes) {
    const { sessionKey, showTitle, season, episode, tvdbId } = ep;
    const label = '"' + showTitle + '" S' + pad(season) + 'E' + pad(episode);
    try {
      // Dedup: skip if webhook already handled this episode recently
      const dedupKey = showTitle + '-S' + pad(season) + 'E' + pad(episode);
      const dedupTs = webhookDeduped.get(dedupKey);
      if (dedupTs && Date.now() - dedupTs < WEBHOOK_DEDUP_TTL_MS) {
        console.log('[watcher] ' + label + ' already handled by webhook - skipping poll');
        continue;
      }
      // Prune stale dedup entries
      for (const [k, ts] of webhookDeduped) {
        if (Date.now() - ts >= WEBHOOK_DEDUP_TTL_MS) webhookDeduped.delete(k);
      }

      const series = tvdbId ? await findSeriesByTvdbId(tvdbId) : null;
      if (!series) {
        console.warn('[watcher] ' + label + ' not found in Sonarr - skipping');
        continue;
      }
      const cacheKey = series.id + '-S' + season + 'E' + episode;
      if (processed.get(sessionKey) === cacheKey) {
        console.log('[watcher] ' + label + ' already processed this session');
        continue;
      }
      await processEpisode(ep, series, 'poll');
      processed.set(sessionKey, cacheKey);
      state.lastError = null;
    } catch (err) {
      state.lastError = err.message;
      console.error('[watcher] Error processing ' + label + ':', err.message);
      logEvent({ event_type: 'error', show_title: showTitle, season, episode, details: { message: err.message, trigger: 'poll' } });
    }
  }

  for (const key of processed.keys()) {
    if (!activeSessions.has(key)) processed.delete(key);
  }
}

async function processEpisode(ep, series, trigger) {
  const { showTitle, season, episode } = ep;
  const label = '"' + showTitle + '" S' + pad(season) + 'E' + pad(episode);

  // Currently playing/watched = on disk by definition — no Sonarr check needed
  console.log('[watcher] ' + label + ' playing - on disk');
  logEvent({ event_type: 'episode_confirmed', show_title: showTitle, season, episode,
    details: { message: 'Currently playing', trigger } });

  // Fetch current + next season once, share across both checks
  console.log('[watcher] Fetching S' + pad(season) + '+S' + pad(season + 1) + ' episodes for ' + label);
  const preloaded = await getTwoSeasonEpisodes(series.id, season);

  // 1. Ensure upcoming episodes
  console.log('[watcher] Checking upcoming for ' + label);
  const result = await ensureUpcomingEpisodes(series.id, season, episode, preloaded);

  // Log one row per upcoming episode action
  for (const a of result.actions) {
    const epSeason  = a.season;
    const epEpisode = a.episode;
    if (a.action === 'skipped_on_disk') {
      logEvent({ event_type: 'episode_skipped', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: 'Already on disk, no action needed', trigger } });
    } else if (a.action === 'skipped_future_airdate') {
      const airMsg = a.airDateUtc ? ' - airs ' + new Date(a.airDateUtc).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      logEvent({ event_type: 'episode_skipped', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: 'Not aired yet' + airMsg, trigger, airDateUtc: a.airDateUtc } });
    } else if (a.action === 'set_monitored') {
      const airMsg = a.airDateUtc ? ' - airs ' + new Date(a.airDateUtc).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      logEvent({ event_type: 'episode_monitored', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: 'Set monitored' + airMsg, trigger,
          apiCall: a.apiCall, apiStatus: a.apiStatus } });
    } else if (a.action === 'search_triggered') {
      logEvent({ event_type: 'episode_grabbed', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: 'Search triggered - missing episode', trigger,
          apiCall: a.apiCall, apiStatus: a.apiStatus } });
    }
  }

  console.log('[watcher] ' + label + ' - monitored ' + result.monitored + ', grabbed ' + result.grabbed + ', skipped ' + result.skipped + ', future ' + result.future);

  // 2. Season-end pre-load (reuses preloaded episodes — no extra API call)
  const seasonPreloaded = await checkSeasonEndAndPreload(series.id, season, episode, preloaded);
  if (seasonPreloaded) {
    logEvent({ event_type: 'season_monitored', show_title: showTitle, season: season + 1,
      details: { message: 'Near season end - S' + pad(season + 1) + ' pre-monitored', trigger } });
    console.log('[watcher] ' + label + ' - near season end, pre-monitoring S' + pad(season + 1));
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
