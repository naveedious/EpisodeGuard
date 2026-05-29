import { Router } from 'express';
import { getAllSettings, setSettings, getDashboardStats, getRecentActivity } from '../db.js';
import { getPlayingEpisodes } from '../tautulli.js';
import { state, restartPolling } from '../watcher.js';

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    lastPollAt: state.lastPollAt,
    nextPollAt: state.nextPollAt,
    isRunning:  state.isRunning,
    lastError:  state.lastError,
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const [stats, activity, nowPlaying] = await Promise.all([
      Promise.resolve(getDashboardStats()),
      Promise.resolve(getRecentActivity(100)),
      getPlayingEpisodes().catch(() => []),
    ]);

    res.json({ stats, activity, nowPlaying, status: {
      lastPollAt: state.lastPollAt,
      nextPollAt: state.nextPollAt,
      isRunning:  state.isRunning,
      lastError:  state.lastError,
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  res.json(getAllSettings());
});

router.post('/settings', (req, res) => {
  const allowed = [
    'poll_interval_seconds',
    'lookahead_episodes',
    'season_end_buffer',
    'backfill_mode',
    'sonarr_quality_profile_id',
    'sonarr_root_folder',
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid settings provided' });
  }

  // Validate numerics
  const numerics = ['poll_interval_seconds', 'lookahead_episodes', 'season_end_buffer', 'sonarr_quality_profile_id'];
  for (const key of numerics) {
    if (updates[key] !== undefined) {
      const n = parseInt(updates[key], 10);
      if (isNaN(n) || n < 1) return res.status(400).json({ error: `${key} must be a positive integer` });
      updates[key] = String(n);
    }
  }

  setSettings(updates);

  // Hot-reload watcher if poll interval changed
  if (updates.poll_interval_seconds) {
    restartPolling();
  }

  res.json({ ok: true, settings: getAllSettings() });
});

export default router;
