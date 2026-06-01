import { env } from './config.js';

async function jellyfinGet(path) {
  const url = env.jellyfinUrl + path;
  const res = await fetch(url, {
    headers: { 'X-Emby-Token': env.jellyfinApiKey },
  });
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status} for ${path}`);
  return res.json();
}

/** Fetch TVDB ID for a series item. Returns null if not present. */
async function getTvdbId(seriesId) {
  try {
    const item = await jellyfinGet(`/Items/${seriesId}?fields=ProviderIds`);
    const id = item?.ProviderIds?.Tvdb ?? item?.ProviderIds?.tvdb ?? null;
    return id ? parseInt(id, 10) : null;
  } catch {
    return null;
  }
}

/** Currently playing TV episodes across all users. */
export async function getJellyfinSessions() {
  const sessions = await jellyfinGet('/Sessions');
  const tvSessions = sessions.filter(
    s => s.NowPlayingItem && s.NowPlayingItem.Type === 'Episode'
  );

  // Fetch TVDB IDs in parallel
  const results = await Promise.all(
    tvSessions.map(async s => {
      const item = s.NowPlayingItem;
      const seriesId = item.SeriesId;
      const tvdbId = seriesId ? await getTvdbId(seriesId) : null;

      return {
        sessionKey:  `jellyfin-${s.Id}`,
        showTitle:   item.SeriesName,
        season:      item.ParentIndexNumber ?? 0,
        episode:     item.IndexNumber ?? 0,
        tvdbId,
        source:      'jellyfin',
      };
    })
  );

  return results.filter(e => e.season > 0 && e.episode > 0);
}
