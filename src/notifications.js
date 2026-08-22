import { getSetting } from './db.js';

function epLabel(season, episode) {
  if (season == null) return '';
  return `S${String(season).padStart(2, '0')}E${String(episode ?? 0).padStart(2, '0')}`;
}

/**
 * Sends a notification to the configured Apprise URL if the event type
 * is in the enabled events list.
 */
export async function sendAppriseNotification(eventType, { showTitle, season, episode, details } = {}) {
  const url = getSetting('apprise_url');
  if (!url) return;

  const enabledRaw = getSetting('apprise_events') ?? 'episode_grabbed';
  const enabled = enabledRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (!enabled.includes(eventType)) return;

  const ep = epLabel(season, episode);
  const show = showTitle ?? '';

  const titles = {
    episode_grabbed:    `Episode Guard — Episode Grabbed`,
    episode_monitored:  `Episode Guard — Episode Monitored`,
    season_monitored:   `Episode Guard — Season Monitored`,
    episode_remediated: `Episode Guard — Bad File Remediated`,
    episode_corrupt:    `Episode Guard — Corrupt File Warning`,
    error:              `Episode Guard — Error`,
  };

  const bodies = {
    episode_grabbed:    `${show} ${ep} — search triggered (not yet on disk)`,
    episode_monitored:  `${show} ${ep} — not monitored; set monitored and search triggered`,
    season_monitored:   `${show} S${String(season ?? 0).padStart(2, '0')} — season pre-monitored near season end`,
    episode_remediated: `${show} ${ep} — bad/truncated file deleted, search queued in Sonarr: ${details?.message ?? ''}`,
    episode_corrupt:    `${show} ${ep} — corrupt/truncated file detected: ${details?.message ?? ''}`,
    error:              `${show} ${ep} — ${details?.message ?? 'unknown error'}`,
  };

  const title = titles[eventType] ?? `Episode Guard — ${eventType}`;
  const body  = bodies[eventType] ?? `${show} ${ep}`;

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      console.warn(`[apprise] HTTP ${res.status} for event ${eventType}`);
    }
  } catch (err) {
    console.error('[apprise] Notification failed:', err.message);
  }
}
