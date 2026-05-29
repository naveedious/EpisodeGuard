import { getPlayingEpisodes, getRecentlyWatchedEpisodes } from './tautulli.js';
import {
  findSeriesByTvdbId,
  ensureUpcomingEpisodes,
  checkSeasonEndAndPreload,
} from './sonarr.js';
import { getSetting, logEvent } from './db.js';

// ── State (exposed to API) ────────────────────────────────────────────────

export const state = {
  lastPollAt:  null,   // ISO string
  nextPollAt:  null,   // ISO string
  isRunning:   false,
  lastError:   null,
};

// Track processed sessions: sessionKey → `${seriesId}-S${s}E${e}`
const processed = new Map();

let pollTimer = null;

// ── Public controls ───────────────────────────────────────────────────────

export function startPolling() {
  const intervalMs = parseInt(getSetting('poll_interval_seconds'), 10) * 1000;
  console.log(`[watcher] Starting — poll every ${intervalMs / 1000}s`);
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

// ── Internal ──────────────────────────────────────────────────────────────

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
  console.log(`[watcher] Poll — ${state.lastPollAt}`);

  let episodes;
  try {
    const [playing, recent] = await Promise.all([
      getPlayingEpisodes(),
      getRecentlyWatchedEpisodes(parseInt(getSetting('poll_interval_seconds'), 10) * 2),
    ]);

    // Deduplicate: active sessions win over history entries
    const seen = new Set(playing.map(e => `${e.showTitle}-S${e.season}E${e.episode}`));
    const uniqueRecent = recent.filter(
      e => !seen.has(`${e.showTitle}-S${e.season}E${e.episode}`)
    );
    episodes = [...playing, ...uniqueRecent];
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
    const label = `"${showTitle}" S${pad(season)}E${pad(episode)}`;

    try {
      const series = tvdbId ? await findSeriesByTvdbId(tvdbId) : null;

      if (!series) {
        console.warn(`[watcher] ${label} not found in Sonarr — skipping`);
        continue;
      }

      const cacheKey = `${series.id}-S${season}E${episode}`;
      if (processed.get(sessionKey) === cacheKey) {
        console.log(`[watcher] ${label} already processed this session`);
        continue;
      }

      // Ensure upcoming episodes
      console.log(`[watcher] Checking upcoming for ${label}`);
      const result = await ensureUpcomingEpisodes(series.id, season, episode);

      if (result.grabbed > 0) {
        logEvent({ event_type: 'episode_grabbed', show_title: showTitle, season, episode, episode_count: result.grabbed });
        console.log(`[watcher] ${label} — grabbed ${result.grabbed}, skipped ${result.skipped}`);
      } else if (result.skipped > 0) {
        console.log(`[watcher] ${label} — next ${result.skipped} episode(s) already on disk ✓`);
      }

      // Season-end pre-load check
      const preloaded = await checkSeasonEndAndPreload(series.id, season, episode);
      if (preloaded) {
        logEvent({ event_type: 'season_monitored', show_title: showTitle, season: season + 1, details: { reason: 'season_end_preload' } });
        console.log(`[watcher] ${label} — near season end, pre-monitoring S${pad(season + 1)}`);
      }

      processed.set(sessionKey, cacheKey);
      state.lastError = null;

    } catch (err) {
      state.lastError = err.message;
      console.error(`[watcher] Error processing ${label}:`, err.message);
      logEvent({ event_type: 'error', show_title: showTitle, season, episode, details: { message: err.message } });
    }
  }

  // Prune stale session keys
  for (const key of processed.keys()) {
    if (!activeSessions.has(key)) processed.delete(key);
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
