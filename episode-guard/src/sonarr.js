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

export async function findSeriesByTvdbId(tvdbId) {
  const all = await sonarrReq('GET', '/series');
  return all.find(s => s.tvdbId === tvdbId) ?? null;
}

async function getEpisodes(seriesId) {
  return sonarrReq('GET', '/episode?seriesId=' + seriesId);
}

export async function confirmCurrentEpisode(seriesId, season, episode) {
  const allEps = await getEpisodes(seriesId);
  const ep = allEps.find(e => e.seasonNumber === season && e.episodeNumber === episode);

  if (!ep) return { status: 'not_found' };

  if (ep.hasFile) return { status: 'on_disk', episodeId: ep.id };

  if (!ep.monitored) {
    console.log('[sonarr] S' + pad(season) + 'E' + pad(episode) + ' unmonitored -> setting monitored');
    await sonarrReq('PUT', '/episode/monitor', { episodeIds: [ep.id], monitored: true });
  }

  console.log('[sonarr] Triggering EpisodeSearch for episode id=' + ep.id + ' (not on disk)');
  await sonarrReq('POST', '/command', { name: 'EpisodeSearch', episodeIds: [ep.id] });

  return { status: 'searched', episodeId: ep.id, wasUnmonitored: !ep.monitored };
}

export async function ensureUpcomingEpisodes(seriesId, season, episode) {
  const lookahead = parseInt(getSetting('lookahead_episodes'), 10);
  const allEps = await getEpisodes(seriesId);

  allEps.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);

  const currentIdx = allEps.findIndex(
    e => e.seasonNumber === season && e.episodeNumber === episode
  );
  const startIdx = currentIdx === -1 ? 0 : currentIdx + 1;
  const upcoming = allEps.slice(startIdx, startIdx + lookahead);

  if (!upcoming.length) return { monitored: 0, grabbed: 0, skipped: 0, actions: [] };

  const actions = [];

  const unmonitored = upcoming.filter(e => !e.monitored);
  if (unmonitored.length) {
    const ids = unmonitored.map(e => e.id);
    console.log('[sonarr] Setting ' + ids.length + ' episode(s) to monitored: ids=[' + ids + ']');
    let monitorStatus;
    try {
      await sonarrReq('PUT', '/episode/monitor', { episodeIds: ids, monitored: true });
      monitorStatus = 'ok';
    } catch (err) {
      monitorStatus = 'failed: ' + err.message;
      console.error('[sonarr] Monitor PUT failed:', err.message);
    }
    for (const ep of unmonitored) {
      actions.push({
        episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
        action: 'set_monitored',
        apiCall: { method: 'PUT', path: '/episode/monitor', body: { episodeIds: ids, monitored: true } },
        apiStatus: monitorStatus,
      });
    }
  }

  const now     = Date.now();
  const onDisk  = upcoming.filter(e => e.hasFile);
  // Only search episodes that have already aired (or have no air date set)
  const missing = upcoming.filter(e => !e.hasFile && (!e.airDateUtc || new Date(e.airDateUtc).getTime() <= now));
  const future  = upcoming.filter(e => !e.hasFile && e.airDateUtc && new Date(e.airDateUtc).getTime() > now);

  for (const ep of future) {
    console.log('[sonarr] Skipping future episode S' + pad(ep.seasonNumber) + 'E' + pad(ep.episodeNumber) + ' (airs ' + ep.airDateUtc + ')');
    actions.push({ episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber, action: 'skipped_future_airdate', airDateUtc: ep.airDateUtc });
  }

  for (const ep of onDisk) {
    actions.push({ episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber, action: 'skipped_on_disk' });
  }

  if (missing.length) {
    const ids = missing.map(e => e.id);
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
    for (const ep of missing) {
      actions.push({
        episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
        action: 'search_triggered', reason: 'not_on_disk',
        apiCall: { method: 'POST', path: '/command', body: requestBody },
        apiStatus: searchStatus,
      });
    }
  }

  return { monitored: unmonitored.length, grabbed: missing.length, skipped: onDisk.length, future: future.length, actions };
}

export async function checkSeasonEndAndPreload(seriesId, season, episode) {
  const buffer  = parseInt(getSetting('season_end_buffer'), 10);
  const allEps  = await getEpisodes(seriesId);

  const seasonEps = allEps.filter(e => e.seasonNumber === season && e.seasonNumber > 0);
  if (!seasonEps.length) return false;

  const lastEpNum    = Math.max(...seasonEps.map(e => e.episodeNumber));
  const epsRemaining = lastEpNum - episode;
  if (epsRemaining > buffer) return false;

  const nextSeason    = season + 1;
  const nextSeasonEps = allEps.filter(e => e.seasonNumber === nextSeason);
  if (!nextSeasonEps.length) return false;

  const series        = await sonarrReq('GET', '/series/' + seriesId);
  const nextSeasonObj = series.seasons.find(s => s.seasonNumber === nextSeason);

  if (nextSeasonObj && !nextSeasonObj.monitored) {
    nextSeasonObj.monitored = true;
    console.log('[sonarr] Setting S' + pad(nextSeason) + ' to monitored for seriesId=' + seriesId);
    await sonarrReq('PUT', '/series/' + seriesId, series);
  }

  console.log('[sonarr] SeasonSearch seriesId=' + seriesId + ' season=' + nextSeason);
  await sonarrReq('POST', '/command', { name: 'SeasonSearch', seriesId, seasonNumber: nextSeason });
  return true;
}

function pad(n) { return String(n).padStart(2, '0'); }
