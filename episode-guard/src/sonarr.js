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

  // Search directly — do not touch monitored status (Sonarr searches regardless)
  console.log('[sonarr] Triggering EpisodeSearch for episode id=' + ep.id + ' (not on disk, monitored=' + ep.monitored + ')');
  await sonarrReq('POST', '/command', { name: 'EpisodeSearch', episodeIds: [ep.id] });

  return { status: 'searched', episodeId: ep.id, monitored: ep.monitored };
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

  return { monitored: futureUnmonitored.length, grabbed: missing.length, skipped: onDisk.length, future: future.length, actions };
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

  const now = Date.now();
  const firstEp = [...nextSeasonEps].sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
  const firstAirMs = firstEp.airDateUtc ? new Date(firstEp.airDateUtc).getTime() : null;
  const hasAired = firstAirMs !== null && firstAirMs <= now;

  if (!hasAired) {
    // Next season not out yet — monitor only so Sonarr auto-grabs on release, no search
    const series        = await sonarrReq('GET', '/series/' + seriesId);
    const nextSeasonObj = series.seasons.find(s => s.seasonNumber === nextSeason);
    if (!nextSeasonObj || nextSeasonObj.monitored) {
      console.log('[sonarr] S' + pad(nextSeason) + ' already monitored or not found, no change');
      return false;
    }
    nextSeasonObj.monitored = true;
    console.log('[sonarr] Setting S' + pad(nextSeason) + ' to monitored (not yet aired) for seriesId=' + seriesId);
    await sonarrReq('PUT', '/series/' + seriesId, series);
    return true;
  }

  // Next season has aired — leave monitored status alone, search missing episodes by ID
  // (EpisodeSearch by ID bypasses monitored status, unlike SeasonSearch which skips unmonitored)
  const missing = nextSeasonEps.filter(
    e => !e.hasFile && e.airDateUtc && new Date(e.airDateUtc).getTime() <= now
  );
  if (!missing.length) {
    console.log('[sonarr] S' + pad(nextSeason) + ' has aired, all episodes on disk - no action');
    return false;
  }

  const ids = missing.map(e => e.id);
  console.log('[sonarr] S' + pad(nextSeason) + ' has aired, EpisodeSearch for ' + ids.length + ' missing episode(s): ids=[' + ids + ']');
  await sonarrReq('POST', '/command', { name: 'EpisodeSearch', episodeIds: ids });
  return true;
}

function pad(n) { return String(n).padStart(2, '0'); }
