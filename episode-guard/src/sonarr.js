import { env } from './config.js';
import { getSetting } from './db.js';

async function sonarrReq(method, path, body) {
  const url = `${env.sonarrUrl}/api/v3${path}`;
  const opts = {
    method,
    headers: { 'X-Api-Key': env.sonarrApiKey, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sonarr ${method} ${path} → HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── Series ─────────────────────────────────────────────────────────────────

export async function findSeriesByTvdbId(tvdbId) {
  const all = await sonarrReq('GET', '/series');
  return all.find(s => s.tvdbId === tvdbId) ?? null;
}

export async function lookupSeriesByTitle(title) {
  return sonarrReq('GET', `/series/lookup?term=${encodeURIComponent(title)}`);
}

export async function addSeries(tvdbId) {
  const lookup = await sonarrReq('GET', `/series/lookup?term=tvdb:${tvdbId}`);
  if (!lookup?.length) throw new Error(`No Sonarr lookup result for tvdbId=${tvdbId}`);

  const template = lookup[0];
  return sonarrReq('POST', '/series', {
    ...template,
    qualityProfileId: parseInt(getSetting('sonarr_quality_profile_id'), 10),
    rootFolderPath:   getSetting('sonarr_root_folder'),
    monitored:        true,
    addOptions: {
      searchForMissingEpisodes:       false,
      searchForCutoffUnmetEpisodes:   false,
      monitor: 'none', // we handle monitoring ourselves
    },
  });
}

// ── Episodes ───────────────────────────────────────────────────────────────

export async function getEpisodes(seriesId) {
  return sonarrReq('GET', `/episode?seriesId=${seriesId}`);
}

/**
 * Ensures the next `lookahead` episodes after the playing one are monitored
 * and triggers a search for any not already on disk.
 *
 * Returns { monitored: number, grabbed: number, skipped: number }
 */
export async function ensureUpcomingEpisodes(seriesId, season, episode) {
  const lookahead = parseInt(getSetting('lookahead_episodes'), 10);
  const allEps = await getEpisodes(seriesId);

  // Sort by season asc, episode asc
  allEps.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);

  const currentIdx = allEps.findIndex(
    e => e.seasonNumber === season && e.episodeNumber === episode
  );
  const startIdx = currentIdx === -1 ? 0 : currentIdx + 1;
  const upcoming = allEps.slice(startIdx, startIdx + lookahead);

  if (!upcoming.length) {
    return { monitored: 0, grabbed: 0, skipped: 0 };
  }

  // Monitor unmonitored
  const unmonitored = upcoming.filter(e => !e.monitored);
  if (unmonitored.length) {
    await sonarrReq('PUT', '/episode/monitor', {
      episodeIds: unmonitored.map(e => e.id),
      monitored:  true,
    });
  }

  // Separate on-disk vs missing
  const onDisk  = upcoming.filter(e => e.hasFile);
  const missing = upcoming.filter(e => !e.hasFile);

  if (missing.length) {
    await sonarrReq('POST', '/command', {
      name:       'EpisodeSearch',
      episodeIds: missing.map(e => e.id),
    });
  }

  return {
    monitored: unmonitored.length,
    grabbed:   missing.length,
    skipped:   onDisk.length,
  };
}

/**
 * Checks whether the playing episode is within `seasonEndBuffer` of the
 * season finale. If so, monitors and searches the next season.
 * Returns true if next-season action was taken.
 */
export async function checkSeasonEndAndPreload(seriesId, season, episode) {
  const buffer = parseInt(getSetting('season_end_buffer'), 10);
  const allEps = await getEpisodes(seriesId);

  const seasonEps = allEps.filter(e => e.seasonNumber === season && e.seasonNumber > 0);
  if (!seasonEps.length) return false;

  const lastEpNum = Math.max(...seasonEps.map(e => e.episodeNumber));
  const epsRemaining = lastEpNum - episode;

  if (epsRemaining > buffer) return false;

  // Pre-monitor next season
  const nextSeason = season + 1;
  const nextSeasonEps = allEps.filter(e => e.seasonNumber === nextSeason);
  if (!nextSeasonEps.length) return false; // next season not yet in Sonarr

  const series = await sonarrReq('GET', `/series/${seriesId}`);
  const nextSeasonObj = series.seasons.find(s => s.seasonNumber === nextSeason);

  if (nextSeasonObj && !nextSeasonObj.monitored) {
    nextSeasonObj.monitored = true;
    await sonarrReq('PUT', `/series/${seriesId}`, series);
  }

  await sonarrReq('POST', '/command', {
    name:         'SeasonSearch',
    seriesId,
    seasonNumber: nextSeason,
  });

  return true;
}

/**
 * Monitor all episodes from `fromSeason` onwards and trigger searches.
 * Used when auto-adding a show mid-season.
 */
export async function monitorFromSeason(seriesId, fromSeason) {
  const series = await sonarrReq('GET', `/series/${seriesId}`);

  // Monitor all seasons from fromSeason onwards
  let changed = false;
  for (const s of series.seasons) {
    if (s.seasonNumber >= fromSeason && s.seasonNumber > 0 && !s.monitored) {
      s.monitored = true;
      changed = true;
    }
  }
  if (changed) await sonarrReq('PUT', `/series/${seriesId}`, series);

  await sonarrReq('POST', '/command', {
    name:         'SeasonSearch',
    seriesId,
    seasonNumber: fromSeason,
  });
}
