import fs from 'fs';
import { fullDecode, waitForStableFile } from './decoder.js';
import {
  createRemediation, getRemediation, setRemediationState,
  getActiveRemediations, getNextQueuedRemediation,
  getSetting, logEvent,
} from './db.js';
import {
  getQueueRecords, deleteQueueItem, manualImportEpisode,
  getEpisodeDetail, deleteEpisodeFile, searchEpisode, getEpisodeFile,
} from './sonarr.js';
import { resolveLocalPath } from './prober.js';
import { sendAppriseNotification } from './notifications.js';

const maxAttempts = () => parseInt(process.env.REMEDIATION_MAX_ATTEMPTS || '3', 10);
const queueTimeoutMs = () => parseInt(process.env.REMEDIATION_QUEUE_TIMEOUT_HOURS || '6', 10) * 3600000;
const searchingTimeoutMs = () => parseInt(process.env.REMEDIATION_SEARCHING_TIMEOUT_HOURS || '24', 10) * 3600000;
const downloadsDir = () => process.env.DOWNLOADS_DIR || '';

function pathPrefixes() {
  return {
    dl: { sonarr: process.env.SONARR_PATH_PREFIX || '', local: downloadsDir() },
    media: {
      sonarr: process.env.SONARR_MEDIA_PREFIX || getSetting('sonarr_path_prefix') || '/data/TV',
      local: process.env.EG_MEDIA_PREFIX || getSetting('local_path_prefix') || '/tv',
    },
  };
}

export function resolveDownloadPath(sonarrPath) {
  const p = pathPrefixes().dl;
  if (!p.sonarr || !p.local) return sonarrPath;
  return resolveLocalPath(sonarrPath, p.sonarr, p.local);
}

function resolveMediaPath(sonarrPath) {
  const p = pathPrefixes().media;
  return resolveLocalPath(sonarrPath, p.sonarr, p.local);
}

function logAction(rem, type, details) {
  logEvent({ event_type: type, show_title: rem.show_title, season: rem.season, episode: rem.episode,
    details: typeof details === 'string' ? { message: details } : details });
}

async function notify(rem, message) {
  try {
    await sendAppriseNotification('remediation', {
      showTitle: rem.show_title, season: rem.season, episode: rem.episode, details: message,
    });
  } catch { /* apprise failures never block the loop */ }
}

export async function startRemediation({ episodeId, seriesId, showTitle, season, episode, oldFileId, reason }) {
  const existing = getRemediation(episodeId);
  if (existing && existing.state !== 'exhausted' && existing.state !== 'swapped') return existing;

  if (!downloadsDir()) {
    // Documented fallback: delete-first, as today, with explicit notice.
    try {
      await deleteEpisodeFile(oldFileId);
      await searchEpisode(episodeId);
    } catch (err) {
      console.error('[remediation] fallback delete-first failed:', err.message);
    }
    logAction({ show_title: showTitle, season, episode }, 'remediation_fallback',
      `Corrupt episode detected (${reason}); downloads dir not mounted - delete-first fallback used. New file NOT verified before swap.`);
    await notify({ show_title: showTitle, season, episode }, `Fallback remediation (unverified swap) for S${season}E${episode}`);
    return null;
  }

  const row = createRemediation({ seriesId, episodeId, showTitle, season, episode, oldFileId, reason });
  logAction(row, 'remediation_started', `Verified corrupt (${reason}). Keeping current file, searching for a replacement.`);
  return row;
}

async function findQueueRecord(rem) {
  const records = await getQueueRecords();
  return records.find(r => r.episodeId === rem.episode_id && r.status === 'completed') || null;
}

async function attemptFailed(rem, details) {
  const attempts = rem.attempts + 1;
  const exhausted = attempts >= maxAttempts();
  logAction(rem, 'remediation_attempt', `Attempt ${attempts}/${maxAttempts()} failed: ${details}`);
  if (exhausted) {
    setRemediationState(rem.episode_id, 'exhausted', { attempts, details });
    logAction(rem, 'remediation_exhausted', `Gave up after ${attempts} different releases: ${details}`);
    await notify(rem, `Remediation exhausted for S${rem.season}E${rem.episode} after ${attempts} attempts: ${details}`);
  } else {
    setRemediationState(rem.episode_id, 'searching', { attempts });
    await searchEpisode(rem.episode_id);
  }
}

async function tickSearching(rem) {
  const record = await findQueueRecord(rem);
  if (record) {
    setRemediationState(rem.episode_id, 'verifying', { details: `queueId=${record.id}` });
    return;
  }
  const inState = Date.now() - new Date(rem.state_changed_at + 'Z').getTime();
  const recs = await getQueueRecords();
  const anyForEpisode = recs.some(r => r.episodeId === rem.episode_id);
  if (inState > searchingTimeoutMs() || (!anyForEpisode && inState > 3600000)) {
    await attemptFailed(rem, 'no completed download arrived in time');
  }
}

async function tickVerifying(rem) {
  const record = await findQueueRecord(rem);
  if (!record) {
    setRemediationState(rem.episode_id, 'searching', { details: 'queue item vanished, re-searching' });
    return;
  }
  const local = resolveDownloadPath(record.outputPath);
  try {
    await waitForStableFile(local, { intervalMs: 5000, checks: 2, maxWaitMs: 120000 });
  } catch {
    const inState = Date.now() - new Date(rem.state_changed_at + 'Z').getTime();
    if (inState > queueTimeoutMs()) {
      try { await deleteQueueItem(record.id, { removeFromClient: true, blocklist: true }); } catch {}
      await attemptFailed(rem, 'queued file never stabilised (queue timeout)');
    }
    return; // still extracting — keep waiting until timeout
  }

  const decoded = await fullDecode(local, { timeoutMs: 300000 });
  if (decoded.pass) {
    setRemediationState(rem.episode_id, 'importing', { details: `verified ${record.outputPath}` });
    return;
  }
  try { await deleteQueueItem(record.id, { removeFromClient: true, blocklist: true }); } catch {}
  await attemptFailed(rem, `replacement decode failed: ${decoded.error}`);
}

async function tickImporting(rem) {
  // First tick in importing: delete old file, then force import.
  // Delete-then-import is required because Sonarr's auto-import refuses a
  // same-quality replacement while the episode has a file. Acceptable gap:
  // the replacement already passed full decode and is safe on disk.
  if (rem.details && rem.details.startsWith('verified ')) {
    if (rem.old_file_id) {
      try {
        await deleteEpisodeFile(rem.old_file_id);
      } catch (err) {
        console.error('[remediation] old file delete failed, retrying next tick:', err.message);
        return;
      }
    }
    const q = await findQueueRecord(rem);
    if (!q) {
      setRemediationState(rem.episode_id, 'searching', { details: 'verified item vanished pre-import, re-searching' });
      return;
    }
    try {
      await manualImportEpisode({ outputPath: q.outputPath, episodeId: rem.episode_id });
      setRemediationState(rem.episode_id, 'importing', { details: `imported ${q.outputPath}` });
    } catch (err) {
      console.error('[remediation] manual import failed:', err.message);
      setRemediationState(rem.episode_id, 'importing', { details: 'import command failed, retrying' });
    }
    return;
  }

  // Post-import verify on the FINAL file (spec: belt-and-braces; move is byte-identical)
  const epDetail = await getEpisodeDetail(rem.episode_id).catch(() => null);
  if (!epDetail || !epDetail.hasFile || !epDetail.episodeFileId) return; // import still processing
  const epFile = await getEpisodeFile(epDetail.episodeFileId).catch(() => null);
  if (!epFile || !epFile.path) return;
  const local = resolveMediaPath(epFile.path);
  try {
    await waitForStableFile(local, { intervalMs: 5000, checks: 2, maxWaitMs: 120000 });
  } catch { return; }
  const decoded = await fullDecode(local, { timeoutMs: 300000 });
  if (decoded.pass) {
    setRemediationState(rem.episode_id, 'swapped', { details: 'replacement verified on disk' });
    logAction(rem, 'remediation_swapped', 'Replacement downloaded, verified clean, and imported. Old corrupt file replaced.');
    await notify(rem, `S${rem.season}E${rem.episode}: corrupt file replaced with a verified clean copy.`);
  } else {
    // Anomaly: move should be byte-identical. Notify only, terminal (spec invariant 4).
    setRemediationState(rem.episode_id, 'swapped', { details: `post-import decode failed: ${decoded.error}` });
    logAction(rem, 'remediation_swapped', `POST-IMPORT DECODE FAILED (${decoded.error}) - investigate manually.`);
    await notify(rem, `S${rem.season}E${rem.episode}: imported file failed post-import decode - manual check needed.`);
  }
}

const TICK_PROCESSORS = {
  searching: tickSearching,
  verifying: tickVerifying,
  importing: tickImporting,
};

export async function tickRemediations() {
  // Drive state transitions until a full pass makes no progress (max 5 passes).
  for (let pass = 0; pass < 5; pass++) {
    const active = getActiveRemediations();
    let progress = false;
    for (const rem of active) {
      const row = getRemediation(rem.episode_id); // fresh read: state may change mid-tick
      const before = row.state;
      try {
        const processor = TICK_PROCESSORS[row.state];
        if (processor) await processor(row);
      } catch (err) {
        console.error(`[remediation] tick error for episode ${row.episode_id}:`, err.message);
        logAction(row, 'error', { message: 'remediation tick error: ' + err.message });
      }
      if (getRemediation(rem.episode_id).state !== before) progress = true;
    }
    if (!progress) break;
  }
  // Promote one queued episode if no searching/verifying/importing slot is used.
  const stillActive = getActiveRemediations();
  if (stillActive.length === 0) {
    const next = getNextQueuedRemediation();
    if (next) {
      setRemediationState(next.episode_id, 'searching');
      try {
        await searchEpisode(next.episode_id);
      } catch (err) {
        setRemediationState(next.episode_id, 'queued'); // retry promotion next tick
        console.error('[remediation] search trigger failed:', err.message);
      }
    }
  }
}
