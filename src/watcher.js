import { getPlayingEpisodes, getRecentlyWatchedEpisodes } from './tautulli.js';
import { getJellyfinSessions } from './jellyfin.js';
import {
  findSeries,
  getTwoSeasonEpisodes,
  ensureUpcomingEpisodes,
  checkSeasonEndAndPreload,
  getSonarrQueue,
} from './sonarr.js';
import { getSetting, logEvent, purgeOldLogs } from './db.js';
import { sources } from './config.js';

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
    const series = await findSeries(tvdbId, showTitle);
    if (!series) {
      console.warn('[watcher] ' + label + ' not found in Sonarr (webhook) - skipping');
      logEvent({ event_type: 'error', show_title: showTitle, season, episode,
        details: { message: 'Show not found in Sonarr', trigger: 'webhook', tvdbId } });
      return;
    }
    await processEpisode(ep, series, 'webhook', await getSonarrQueue());
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
  let queuedEpisodeIds;
  try {
    const fetchers = [];
    if (sources.tautulli) {
      if (webhookEnabled) {
        fetchers.push(getPlayingEpisodes().catch(err => { console.error('[watcher] Tautulli error:', err.message); return []; }));
      } else {
        const windowSecs = parseInt(getSetting('poll_interval_seconds'), 10) * 2;
        fetchers.push(
          Promise.all([getPlayingEpisodes(), getRecentlyWatchedEpisodes(windowSecs)])
            .then(([playing, recent]) => {
              const seen = new Set(playing.map(e => e.showTitle + '-S' + e.season + 'E' + e.episode));
              return [...playing, ...recent.filter(e => !seen.has(e.showTitle + '-S' + e.season + 'E' + e.episode))];
            })
            .catch(err => { console.error('[watcher] Tautulli error:', err.message); return []; })
        );
      }
    }
    if (sources.jellyfin) {
      fetchers.push(getJellyfinSessions().catch(err => { console.error('[watcher] Jellyfin error:', err.message); return []; }));
    }

    const [sourcedEps, queue] = await Promise.all([
      Promise.all(fetchers).then(results => results.flat()),
      getSonarrQueue(),
    ]);

    // Dedup across sources: first occurrence wins
    const seen = new Set();
    episodes = [];
    for (const ep of sourcedEps) {
      const key = ep.showTitle + '-S' + pad(ep.season) + 'E' + pad(ep.episode);
      if (seen.has(key)) {
        console.log('[watcher] Cross-source duplicate dropped: ' + key);
        continue;
      }
      seen.add(key);
      episodes.push(ep);
    }
    queuedEpisodeIds = queue;
  } catch (err) {
    state.lastError = err.message;
    console.error('[watcher] Source fetch error:', err.message);
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

      const series = await findSeries(tvdbId, showTitle);
      if (!series) {
        console.warn('[watcher] ' + label + ' not found in Sonarr - skipping');
        continue;
      }
      const cacheKey = series.id + '-S' + season + 'E' + episode;
      if (processed.get(sessionKey) === cacheKey) {
        console.log('[watcher] ' + label + ' already processed this session');
        continue;
      }
      await processEpisode(ep, series, 'poll', queuedEpisodeIds);
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

async function processEpisode(ep, series, trigger, queuedEpisodeIds = new Set()) {
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
  const result = await ensureUpcomingEpisodes(series.id, season, episode, preloaded, queuedEpisodeIds, series.title);

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
    } else if (a.action === 'skipped_in_queue') {
      logEvent({ event_type: 'episode_skipped', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: 'Already in Sonarr queue', trigger } });
    } else if (a.action === 'search_triggered') {
      logEvent({ event_type: 'episode_grabbed', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: 'Search triggered - missing episode', trigger,
          apiCall: a.apiCall, apiStatus: a.apiStatus } });
    } else if (a.action === 'remediated_corrupt_file') {
      logEvent({ event_type: 'episode_remediated', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: a.details || 'Corrupt/truncated episode remediated', trigger, apiStatus: a.apiStatus } });
    } else if (a.action === 'corrupt_file_detected_notify_only') {
      logEvent({ event_type: 'episode_corrupt', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: a.details || 'Corrupt/truncated episode detected (notify only)', trigger } });
    } else if (a.action === 'integrity_checked') {
      logEvent({ event_type: 'integrity_checked', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: a.details || 'Integrity verified clean', trigger } });
    }
  }

  console.log('[watcher] ' + label + ' - monitored ' + result.monitored + ', grabbed ' + result.grabbed + ', skipped ' + result.skipped + ', inQueue ' + result.inQueue + ', future ' + result.future);

  // 2. Season-end pre-load (reuses preloaded episodes — no extra API call)
  const seasonPreloaded = await checkSeasonEndAndPreload(series.id, season, episode, preloaded);
  if (seasonPreloaded) {
    logEvent({ event_type: 'season_monitored', show_title: showTitle, season: season + 1,
      details: { message: 'Near season end - S' + pad(season + 1) + ' pre-monitored', trigger } });
    console.log('[watcher] ' + label + ' - near season end, pre-monitoring S' + pad(season + 1));
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
