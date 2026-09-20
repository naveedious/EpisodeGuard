import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock env.dataDir before importing db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-test-'));
process.env.DATA_DIR = tmpDir;

const {
  getDb,
  getSetting,
  getAllSettings,
  setSettings,
  isEpisodeFileVerified,
  markEpisodeFileVerified,
  clearVerifiedFile,
  SETTING_DEFAULTS
} = await import('../src/db.js');

test('db schema includes verified_files and new default settings', (t) => {
  const db = getDb();
  
  // Verify default settings
  assert.equal(getSetting('integrity_check_mode'), 'auto_remediate');
  assert.equal(getSetting('runtime_tolerance_percent'), '80');
  assert.equal(getSetting('probe_tail_seconds'), '30');
  assert.equal(getSetting('sonarr_path_prefix'), '/data/TV');
  assert.equal(getSetting('local_path_prefix'), '/tv');
  assert.equal(getSetting('integrity_log_checks'), '0');

  // Verify verified_files cache operations
  assert.equal(isEpisodeFileVerified(12345), null);

  markEpisodeFileVerified(12345, 'valid', { runtime: 2700, details: 'OK' });
  const cached = isEpisodeFileVerified(12345);
  assert.ok(cached);
  assert.equal(cached.status, 'valid');
  assert.equal(cached.runtime_sec, 2700);

  clearVerifiedFile(12345);
  assert.equal(isEpisodeFileVerified(12345), null);
});

// --- remediation_episodes ---

const { createRemediation, getRemediation, setRemediationState,
        getActiveRemediations, getNextQueuedRemediation,
        resetRemediation, getRemediations } = await import('../src/db.js');

test('remediation CRUD round-trip', () => {
  const row = createRemediation({ seriesId: 1, episodeId: 42, showTitle: 'Sunny',
    season: 12, episode: 3, oldFileId: 7, reason: 'corrupt_stream: boom' });
  assert.equal(row.state, 'queued');
  assert.equal(getRemediation(42).old_file_id, 7);

  setRemediationState(42, 'searching');
  assert.equal(getActiveRemediations().length, 1);
  assert.equal(getNextQueuedRemediation(), null);

  const second = createRemediation({ seriesId: 1, episodeId: 43, showTitle: 'Sunny',
    season: 12, episode: 4, oldFileId: 8, reason: 'x' });
  assert.equal(second.state, 'queued');
  assert.equal(getNextQueuedRemediation().episode_id, 43);

  setRemediationState(42, 'swapped', { details: 'done', attempts: 1 });
  assert.equal(getRemediation(42).state, 'swapped');
  assert.equal(getActiveRemediations().length, 0);

  assert.equal(getRemediations().length, 2);
  resetRemediation(42);
  assert.equal(getRemediation(42), null);
});
