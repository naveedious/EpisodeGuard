import { env } from './config.js';

async function tautulliGet(cmd, params = {}) {
  const url = new URL(`${env.tautulliUrl}/api/v2`);
  url.searchParams.set('apikey', env.tautulliApiKey);
  url.searchParams.set('cmd', cmd);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status} for cmd=${cmd}`);
  const json = await res.json();
  if (json.response?.result !== 'success') {
    throw new Error(`Tautulli error: ${json.response?.message}`);
  }
  return json.response.data;
}

function parseSession(s) {
  return {
    sessionKey:          s.session_key,
    showTitle:           s.grandparent_title,
    season:              parseInt(s.parent_media_index, 10),
    episode:             parseInt(s.media_index, 10),
    tvdbId:              parseTvdbId(s.grandparent_guids),
    grandparentRatingKey: s.grandparent_rating_key,
  };
}

/** Currently playing TV episodes. */
export async function getPlayingEpisodes() {
  const data = await tautulliGet('get_activity');
  return (data.sessions ?? [])
    .filter(s => s.media_type === 'episode')
    .map(parseSession);
}

/**
 * TV episodes from watch history in the last `windowSeconds` seconds.
 * Used as a safety net when a session ends before the next poll fires.
 */
export async function getRecentlyWatchedEpisodes(windowSeconds) {
  const data = await tautulliGet('get_history', {
    media_type: 'episode',
    length: 50,
  });

  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  return (data.data ?? [])
    .filter(h => h.media_type === 'episode' && parseInt(h.started, 10) >= cutoff)
    .map(h => ({
      sessionKey:          `history-${h.id}`,
      showTitle:           h.grandparent_title,
      season:              parseInt(h.parent_media_index, 10),
      episode:             parseInt(h.media_index, 10),
      tvdbId:              parseTvdbId(h.grandparent_guids),
      grandparentRatingKey: h.grandparent_rating_key,
    }));
}

function parseTvdbId(guids) {
  if (!Array.isArray(guids)) return null;
  for (const g of guids) {
    const m = String(g).match(/^tvdb:\/\/(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
