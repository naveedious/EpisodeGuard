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

// --- state machine ---

const { startRemediation, tickRemediations } = await import('../src/remediation.js');

function makeMedia(dir, name, { corrupt = false } = {}) {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=2:size=128x96:rate=10', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
  if (corrupt) {
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(2048, 0xff), 0, 2048, Math.floor(fs.statSync(file).size / 2));
    fs.closeSync(fd);
  }
  return file;
}

function setupPathMaps({ dlDir, mediaDir }) {
  process.env.DOWNLOADS_DIR = dlDir;            // local mount == real temp dir
  process.env.SONARR_PATH_PREFIX = '/data/Downloads';
  process.env.SONARR_MEDIA_PREFIX = '/data/TV';
  process.env.EG_MEDIA_PREFIX = mediaDir;
}

test('startRemediation queues second episode behind the first (concurrency cap)', async () => {
  const restore = installSonarrMock();
  try {
    setupPathMaps({ dlDir: fs.mkdtempSync(path.join(os.tmpdir(), 'eg-dl0-')), mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'eg-media-')) });
    await startRemediation({ episodeId: 42, seriesId: 1, showTitle: 'Sunny', season: 12, episode: 3,
      oldFileId: 7, reason: 'corrupt_stream' });
    await startRemediation({ episodeId: 43, seriesId: 1, showTitle: 'Sunny', season: 12, episode: 4,
      oldFileId: 8, reason: 'corrupt_stream' });
    await tickRemediations();
    assert.equal(getRemediation(42).state, 'searching');
    assert.equal(getRemediation(43).state, 'queued');
  } finally { resetRemediation(42); resetRemediation(43); restore(); }
});

test('clean flow: searching -> verifying -> importing (old file deleted after verify) -> swapped', async () => {
  const restore = installSonarrMock();
  try {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-dl-'));
    const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-media-'));
    setupPathMaps({ dlDir, mediaDir });
    fs.mkdirSync(dlDir + '/tv', { recursive: true });
    const queued = makeMedia(dlDir + '/tv', 'sunny.s12e03.mkv');
    sonarrMockState.episode = { id: 42, hasFile: true, episodeFileId: 7 };
    sonarrMockState.queue = [{ id: 5, episodeId: 42, status: 'completed',
      outputPath: '/data/Downloads/tv/sunny.s12e03.mkv', trackedDownloadStatus: 'ImportPending', size: fs.statSync(queued).size }];

    createRemediation({ seriesId: 1, episodeId: 42, showTitle: 'Sunny', season: 12, episode: 3,
      oldFileId: 7, reason: 'corrupt_stream' });
    setRemediationState(42, 'searching');

    await tickRemediations(); // searching -> verifying -> importing (verify clean, delete old, import)
    assert.equal(getRemediation(42).state, 'importing');
    assert.ok(sonarrMockState.calls.some(c => c.method === 'POST' && c.path === '/command' && c.body.name === 'DownloadedEpisodesScan'));
    const epDeletes = sonarrMockState.calls.filter(c => c.method === 'DELETE' && /episodefile/.test(c.path));
    assert.equal(epDeletes.length, 1);
    assert.match(epDeletes[0].path, /episodefile\/7/);
    // the delete must have come AFTER the queued file was verified (importing details set first)
    const importCmdIdx = sonarrMockState.calls.findIndex(c => c.method === 'POST' && c.body?.name === 'DownloadedEpisodesScan');

    // post-import: Sonarr reports new file id 99 with a healthy file at the mapped final path
    fs.mkdirSync(path.join(mediaDir, 'Sunny', 'Season 12'), { recursive: true });
    fs.copyFileSync(queued, path.join(mediaDir, 'Sunny', 'Season 12', 'sunny.s12e03.mkv'));
    sonarrMockState.episode = { id: 42, hasFile: true, episodeFileId: 99 };
    sonarrMockState.episodeFile = { id: 99, path: '/data/TV/Sunny/Season 12/sunny.s12e03.mkv' };
    await tickRemediations();
    assert.equal(getRemediation(42).state, 'swapped');
    assert.equal(sonarrMockState.calls.filter(c => c.method === 'DELETE' && /episodefile/.test(c.path)).length, 1);
  } finally { resetRemediation(42); restore(); }
});

test('corrupt replacements are blocklisted, attempts increment, exhaust at cap, old file untouched', async () => {
  const restore = installSonarrMock();
  try {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-dl2-'));
    setupPathMaps({ dlDir, mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'eg-media2-')) });
    createRemediation({ seriesId: 1, episodeId: 42, showTitle: 'Sunny', season: 12, episode: 3,
      oldFileId: 7, reason: 'corrupt_stream' });
    setRemediationState(42, 'searching');

    for (let i = 0; i < 5; i++) {
      fs.mkdirSync(dlDir + '/tv', { recursive: true });
      const bad = makeMedia(dlDir + '/tv', `rel${i}.mkv`, { corrupt: true });
      sonarrMockState.queue = [{ id: 100 + i, episodeId: 42, status: 'completed',
        outputPath: `/data/Downloads/tv/rel${i}.mkv`, trackedDownloadStatus: 'ImportPending', size: fs.statSync(bad).size }];
      await tickRemediations();
    }
    const row = getRemediation(42);
    assert.equal(row.state, 'exhausted');
    assert.ok(row.attempts >= 3);
    const blockDeletes = sonarrMockState.calls.filter(c => c.method === 'DELETE' && c.path.includes('blocklist=true'));
    assert.ok(blockDeletes.length >= 3);
    // old file NEVER deleted in a failed loop
    assert.equal(sonarrMockState.calls.filter(c => c.method === 'DELETE' && /episodefile/.test(c.path)).length, 0);
  } finally { resetRemediation(42); restore(); }
});
