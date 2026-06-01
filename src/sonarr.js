import { env } from './config.js';
import { getSetting } from './db.js';

async function sonarrReq(method, path, body) {
  const url = env.sonarrUrl + '/api/v3' + path;
  const opts = {
    method,
    headers: { 'X-Api-Key': env.sonarrApiKey, 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error('Sonarr ' + method + ' ' + path + ' - network error: ' + err.message);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Sonarr ' + method + ' ' + path + ' -> HTTP ' + res.status + ': ' + text.slice(0, 200));
  }
  if (res.status === 204) return null;
  return res.json();
}

const QUEUE_SKIP_STATUSES = new Set(['downloading', 'queued', 'delay', 'completed']);

export async function getSonarrQueue() {
  try {
    const data = await sonarrReq('GET', '/queue?pageSize=500&includeEpisode=false');
    const records = data?.records ?? (Array.isArray(data) ? data : []);
    const queuedIds = new Set();
    for (const item of records) {
      if (item.episodeId && QUEUE_SKIP_STATUSES.has(item.status?.toLowerCase())) {
        queuedIds.add(item.episodeId);
      }
    }
    return queuedIds;
  } catch (err) {
    console.error('[sonarr] Failed to fetch queue:', err.message);
    return new Set(); // fail open — don't block normal processing
  }
}

export async function findSeriesByTvdbId(tvdbId) {
  const results = await sonarrReq('GET', '/series?tvdbId=' + tvdbId);
  return Array.isArray(results) ? (results[0] ?? null) : (results ?? null);
}

export async function findSeriesByTitle(title) {
  const all = await sonarrReq('GET', '/series');
  if (!Array.isArray(all)) return null;
  const normalise = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const needle = normalise(title);
  const matches = all.filter(s => normalise(s.title) === needle);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.warn('[sonarr] Title "' + title + '" matched ' + matches.length + ' series: ' +
      matches.map(s => '"' + s.title + '" (id=' + s.id + ')').join(', ') +
      ' - skipping. Add TVDB metadata to disambiguate.');
    return null;
  }
  return null;
}

/** Find by TVDB ID first, fall back to title match. */
export async function findSeries(tvdbId, title) {
  if (tvdbId) {
    const byId = await findSeriesByTvdbId(tvdbId);
    if (byId) return byId;
  }
  if (title) return findSeriesByTitle(title);
  return null;
}

async function getSeasonEpisodes(seriesId, season) {
  return sonarrReq('GET', '/episode?seriesId=' + seriesId + '&seasonNumber=' + season);
}

export async function getTwoSeasonEpisodes(seriesId, season) {
  const [current, next] = await Promise.all([
    getSeasonEpisodes(seriesId, season),
    getSeasonEpisodes(seriesId, season + 1),
  ]);
  return { current: current ?? [], next: next ?? [] };
}


export async function ensureUpcomingEpisodes(seriesId, season, episode, preloaded, queuedEpisodeIds = new Set()) {
  const lookahead = parseInt(getSetting('lookahead_episodes'), 10);
  const allEps = preloaded
    ? [...preloaded.current, ...preloaded.next]
    : await (async () => {
        const { current, next } = await getTwoSeasonEpisodes(seriesId, season);
        return [...current, ...next];
      })();

  allEps.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);

  const currentIdx = allEps.findIndex(
    e => e.seasonNumber === season && e.episodeNumber === episode
  );
  const startIdx = currentIdx === -1 ? 0 : currentIdx + 1;
  const upcoming = allEps.slice(startIdx, startIdx + lookahead);

  if (!upcoming.length) return { monitored: 0, grabbed: 0, skipped: 0, actions: [] };

  const actions = [];
  const now = Date.now();

  const onDisk  = upcoming.filter(e => e.hasFile);
  const future  = upcoming.filter(e => !e.hasFile && e.airDateUtc && new Date(e.airDateUtc).getTime() > now);
  const missing = upcoming.filter(e => !e.hasFile && (!e.airDateUtc || new Date(e.airDateUtc).getTime() <= now));

  // On disk — leave completely alone, don't touch monitored status
  for (const ep of onDisk) {
    actions.push({ episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber, action: 'skipped_on_disk' });
  }

  // Future episodes not on disk — set monitored only so Sonarr auto-grabs on release
  const futureUnmonitored = future.filter(e => !e.monitored);
  if (futureUnmonitored.length) {
    const ids = futureUnmonitored.map(e => e.id);
    console.log('[sonarr] Setting ' + ids.length + ' future episode(s) to monitored: ids=[' + ids + ']');
    let monitorStatus;
    try {
      await sonarrReq('PUT', '/episode/monitor', { episodeIds: ids, monitored: true });
      monitorStatus = 'ok';
    } catch (err) {
      monitorStatus = 'failed: ' + err.message;
      console.error('[sonarr] Monitor PUT failed:', err.message);
    }
    for (const ep of futureUnmonitored) {
      actions.push({
        episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
        action: 'set_monitored',
        apiCall: { method: 'PUT', path: '/episode/monitor', body: { episodeIds: ids, monitored: true } },
        apiStatus: monitorStatus,
      });
    }
  }
  // Future episodes already monitored — just note them
  for (const ep of future.filter(e => e.monitored)) {
    actions.push({ episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber, action: 'skipped_future_airdate', airDateUtc: ep.airDateUtc });
  }
  // Unmonitored future episodes we just set — also note air date for logging
  for (const ep of futureUnmonitored) {
    // already pushed as set_monitored above, add airDateUtc
    const a = actions.find(a => a.episodeId === ep.id && a.action === 'set_monitored');
    if (a) a.airDateUtc = ep.airDateUtc;
  }

  const inQueue  = missing.filter(e => queuedEpisodeIds.has(e.id));
  const toSearch = missing.filter(e => !queuedEpisodeIds.has(e.id));

  for (const ep of inQueue) {
    actions.push({
      episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
      action: 'skipped_in_queue',
    });
  }

  if (toSearch.length) {
    const ids = toSearch.map(e => e.id);
    const requestBody = { name: 'EpisodeSearch', episodeIds: ids };
    console.log('[sonarr] EpisodeSearch for ' + ids.length + ' episode(s): ids=[' + ids + ']');
    let searchStatus;
    try {
      const cmd = await sonarrReq('POST', '/command', requestBody);
      searchStatus = cmd && cmd.id ? 'ok (commandId=' + cmd.id + ')' : 'ok';
    } catch (err) {
      searchStatus = 'failed: ' + err.message;
      console.error('[sonarr] EpisodeSearch failed:', err.message);
    }
    for (const ep of toSearch) {
      actions.push({
        episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
        action: 'search_triggered', reason: 'not_on_disk',
        apiCall: { method: 'POST', path: '/command', body: requestBody },
        apiStatus: searchStatus,
      });
    }
  }

  return { monitored: futureUnmonitored.length, grabbed: toSearch.length, skipped: onDisk.length, inQueue: inQueue.length, future: future.length, actions };
}

export async function checkSeasonEndAndPreload(seriesId, season, episode, preloaded) {
  const buffer = parseInt(getSetting('season_end_buffer'), 10);

  const seasonEps = preloaded
    ? preloaded.current.filter(e => e.seasonNumber > 0)
    : (await getSeasonEpisodes(seriesId, season)).filter(e => e.seasonNumber > 0);
  if (!seasonEps.length) return false;

  const lastEpNum    = Math.max(...seasonEps.map(e => e.episodeNumber));
  const epsRemaining = lastEpNum - episode;
  if (epsRemaining > buffer) return false;

  const nextSeason    = season + 1;
  const nextSeasonEps = preloaded
    ? preloaded.next
    : (await getSeasonEpisodes(seriesId, nextSeason));
  if (!nextSeasonEps.length) return false;

  const now = Date.now();
  const sortedNext = [...nextSeasonEps].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const firstEp    = sortedNext[0];
  const firstAirMs = firstEp.airDateUtc ? new Date(firstEp.airDateUtc).getTime() : null;

  // Partially or fully unaired next season — monitor whole season if not already
  const hasFullyAired = firstAirMs !== null && firstAirMs <= now &&
    nextSeasonEps.every(e => !e.airDateUtc || new Date(e.airDateUtc).getTime() <= now);
  const hasPartiallyOrNotAired = !hasFullyAired;

  if (hasPartiallyOrNotAired) {
    const series        = await sonarrReq('GET', '/series/' + seriesId);
    const nextSeasonObj = series.seasons.find(s => s.seasonNumber === nextSeason);
    if (!nextSeasonObj || nextSeasonObj.monitored) {
      console.log('[sonarr] S' + pad(nextSeason) + ' already monitored or not found, no change');
      // Still search any aired-but-missing episodes even if season is monitored
    } else {
      nextSeasonObj.monitored = true;
      console.log('[sonarr] Setting S' + pad(nextSeason) + ' to monitored (not fully aired) for seriesId=' + seriesId);
      await sonarrReq('PUT', '/series/' + seriesId, series);
    }
    // Search any episodes that have aired but are missing
    const airedMissing = nextSeasonEps.filter(
      e => !e.hasFile && e.airDateUtc && new Date(e.airDateUtc).getTime() <= now
    );
    if (airedMissing.length) {
      const ids = airedMissing.map(e => e.id);
      console.log('[sonarr] S' + pad(nextSeason) + ' partial aired, EpisodeSearch for ' + ids.length + ' missing episode(s): ids=[' + ids + ']');
      await sonarrReq('POST', '/command', { name: 'EpisodeSearch', episodeIds: ids });
    }
    return true;
  }

  // Next season fully aired — search all missing episodes by ID
  const missing = nextSeasonEps.filter(
    e => !e.hasFile && e.airDateUtc && new Date(e.airDateUtc).getTime() <= now
  );
  if (!missing.length) {
    console.log('[sonarr] S' + pad(nextSeason) + ' fully aired, all episodes on disk - no action');
    return false;
  }

  const ids = missing.map(e => e.id);
  console.log('[sonarr] S' + pad(nextSeason) + ' fully aired, EpisodeSearch for ' + ids.length + ' missing episode(s): ids=[' + ids + ']');
  await sonarrReq('POST', '/command', { name: 'EpisodeSearch', episodeIds: ids });
  return true;
}

function pad(n) { return String(n).padStart(2, '0'); }
