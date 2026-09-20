import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// env must exist before config.js/sonarr.js are imported (they snapshot at import time)
process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rem-'));
process.env.SONARR_URL = process.env.SONARR_URL || 'http://sonarr.mock';
process.env.SONARR_API_KEY = process.env.SONARR_API_KEY || 'mock-key';

const { installSonarrMock, sonarrMockState } = await import('./helpers/sonarr-mock.js');
const { getQueueRecords, deleteQueueItem, manualImportEpisode, getEpisodeDetail } = await import('../src/sonarr.js');
const { createRemediation, getRemediation, setRemediationState, resetRemediation } = await import('../src/db.js');

test('queue helpers talk to the right Sonarr endpoints', async () => {
  const restore = installSonarrMock();
  try {
    sonarrMockState.queue = [{
      id: 5, episodeId: 42, status: 'completed', outputPath: '/downloads/tv/x.mkv',
      trackedDownloadStatus: 'ImportPending', size: 1000,
    }];
    const recs = await getQueueRecords();
    assert.equal(recs[0].id, 5);

    await deleteQueueItem(5, { removeFromClient: true, blocklist: true });
    const last = sonarrMockState.calls.at(-1);
    assert.equal(last.method, 'DELETE');
    assert.match(last.path, /\/queue\/5\?removeFromClient=true&blocklist=true/);

    await manualImportEpisode({ outputPath: '/downloads/tv/x.mkv', episodeId: 42 });
    const cmd = sonarrMockState.calls.at(-1);
    assert.equal(cmd.method, 'POST');
    assert.equal(cmd.path, '/command');
    assert.equal(cmd.body.name, 'DownloadedEpisodesScan');
    assert.equal(cmd.body.path, '/downloads/tv/x.mkv');

    const ep = await getEpisodeDetail(42);
    assert.equal(ep.id, 42);
  } finally { restore(); }
});
