import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-api-test-'));
process.env.DATA_DIR = tmpDir;

const { getSetting, getAllSettings, setSettings } = await import('../src/db.js');

test('settings API serialization and persistence', (t) => {
  // Test updating integrity settings
  setSettings({
    integrity_check_mode: 'notify_only',
    runtime_tolerance_percent: '85',
    probe_tail_seconds: '45',
    sonarr_path_prefix: '/media/tv',
    local_path_prefix: '/mnt/media/tv',
    integrity_log_checks: '1',
  });

  const s = getAllSettings();
  assert.equal(s.integrity_check_mode, 'notify_only');
  assert.equal(s.runtime_tolerance_percent, '85');
  assert.equal(s.probe_tail_seconds, '45');
  assert.equal(s.sonarr_path_prefix, '/media/tv');
  assert.equal(s.local_path_prefix, '/mnt/media/tv');
  assert.equal(s.integrity_log_checks, '1');
});
