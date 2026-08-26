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
