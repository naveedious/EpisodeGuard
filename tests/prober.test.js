import test from 'node:test';
import assert from 'node:assert/strict';
import { probeMediaFile, resolveLocalPath, evaluateIntegrity, runTailDecode } from '../src/prober.js';



test('resolveLocalPath correctly rewrites prefixes', () => {
  const sonarrPath = '/data/TV/Breaking Bad/Season 01/S01E01.mkv';
  assert.equal(
    resolveLocalPath(sonarrPath, '/data/TV', '/tv'),
    '/tv/Breaking Bad/Season 01/S01E01.mkv'
  );
  assert.equal(
    resolveLocalPath(sonarrPath, '/data/TV/', '/tv/'),
    '/tv/Breaking Bad/Season 01/S01E01.mkv'
  );
  // Unmatched prefix leaves path as-is
  assert.equal(
    resolveLocalPath(sonarrPath, '/other/prefix', '/tv'),
    sonarrPath
  );
});

test('evaluateIntegrity checks duration tolerance and stream errors', () => {
  // 45 min expected = 2700s, 80% = 2160s
  const expectedSec = 2700;

  // Case 1: Duration too short (e.g. 1500s < 2160s)
  const tooShort = evaluateIntegrity({
    actualDurationSec: 1500,
    expectedRuntimeSec: expectedSec,
    tolerancePercent: 80,
    streamError: null,
  });
  assert.equal(tooShort.valid, false);
  assert.equal(tooShort.reason, 'runtime_too_short');

  // Case 2: Duration normal (2600s >= 2160s), no stream error
  const normal = evaluateIntegrity({
    actualDurationSec: 2600,
    expectedRuntimeSec: expectedSec,
    tolerancePercent: 80,
    streamError: null,
  });
  assert.equal(normal.valid, true);

  // Case 3: Stream corrupt error during decode
  const corrupt = evaluateIntegrity({
    actualDurationSec: 2600,
    expectedRuntimeSec: expectedSec,
    tolerancePercent: 80,
    streamError: 'Invalid data found when processing input',
  });
  assert.equal(corrupt.valid, false);
  assert.equal(corrupt.reason, 'corrupt_stream');
});

test('runTailDecode retries on timeout with doubled timeout, passes stderr errors through', async () => {
  let calls = 0;
  const seen = [];
  const killed = (t) => Object.assign(new Error('killed'), { killed: true });
  const fake = async (args, opts) => { calls += 1; seen.push(opts.timeout); throw killed(); };
  const r = await runTailDecode(fake, ['-v', 'error'], 1000);
  assert.match(r, /probe timeout after retry \(1000ms then 2000ms\)/);
  assert.deepEqual(seen, [1000, 2000]);
  assert.equal(await runTailDecode(async () => null, [], 1000), null);
  const io = Object.assign(new Error('io fail'), { killed: false, stderr: 'boomed' });
  assert.match(await runTailDecode(async () => { throw io; }, [], 1000), /boomed/);
});
