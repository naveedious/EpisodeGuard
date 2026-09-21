import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fullDecode, waitForStableFile, isIoTimeoutError } from '../src/decoder.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eg-decode-'));
}

// Builds a real 2-second mp4, then corrupts bytes in the middle.
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

test('fullDecode passes a healthy file', async () => {
  const file = makeMedia(tmpDir(), 'good.mp4');
  const r = await fullDecode(file);
  assert.equal(r.pass, true);
  assert.equal(r.error, null);
});

test('fullDecode fails a byte-corrupted file', async () => {
  const file = makeMedia(tmpDir(), 'bad.mp4', { corrupt: true });
  const r = await fullDecode(file);
  assert.equal(r.pass, false);
  assert.ok(r.error && r.error.length > 0);
});

test('fullDecode reports file_inaccessible without throwing', async () => {
  const r = await fullDecode(path.join(tmpDir(), 'missing.mp4'));
  assert.equal(r.pass, false);
  assert.match(r.error, /not found or unreadable/i);
});

test('waitForStableFile resolves once size is unchanged', async () => {
  const file = makeMedia(tmpDir(), 'stable.mp4');
  assert.equal(await waitForStableFile(file, { intervalMs: 50, checks: 2 }), true);
});

test('isIoTimeoutError matches timeout and EIO, not generic errors', () => {
  assert.equal(isIoTimeoutError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })), true);
  assert.equal(isIoTimeoutError(new Error('EIO: i/o error')), true);
  assert.equal(isIoTimeoutError(new Error('something else')), false);
});
