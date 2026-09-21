# Integrity Remediation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace delete-first corruption remediation with a verify-before-swap loop: confirm corrupt via full decode, download a replacement while keeping the old file, verify the replacement, swap via Sonarr manual import, re-verify the final file, give up after 3 distinct releases.

**Architecture:** A new `remediation` module owns a per-episode state machine persisted in SQLite (`remediation_episodes` table). The existing watcher poll tick-drives the state machine. `src/decoder.js` adds whole-file ffmpeg decode (shared by the confirm pass and both verification points). Sonarr gains queue-detail / blocklist / manual-import helpers. The existing delete-first path in `src/sonarr.js`'s integrity branch is replaced by confirm + state-machine entry, with delete-first preserved only as the documented fallback when the downloads mount is absent.

**Tech Stack:** Node 22 (ESM), Express, better-sqlite3 (see `src/db.js`), Sonarr v3 API, ffmpeg/ffprobe (already in image), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-20-integrity-remediation-loop-design.md`

## Global Constraints

- Test runner is `node --test tests/*.test.js` (ESM, `type: module`). Never add jest/mocha.
- All DB access goes through `getDb()` in `src/db.js` (better-sqlite3, synchronous).
- Sonarr HTTP goes through `sonarrReq(method, path, body)` in `src/sonarr.js` (private). New Sonarr helpers must live in `src/sonarr.js` and be exported.
- Never delete an episode file unless a verified-clean replacement exists — enforced only in the swap step. Exception: the documented fallback (downloads mount missing), which must emit a `remediation_fallback` notification.
- Retry semantics: max 3 attempts, each failed release blocklisted via Sonarr queue deletion with `blocklist=true`.
- Time bounds: queue item stuck (non-completed) > `REMEDIATION_QUEUE_TIMEOUT_HOURS` (default 6) = failed attempt; `searching` state with no completed item > `REMEDIATION_SEARCHING_TIMEOUT_HOURS` (default 24) = exhausted.
- Global concurrency: at most 1 episode in active remediation states (`searching`/`verifying`/`importing`) at a time; others wait in `queued` (order by row id).
- Post-import full-decode failure is notify-only; it never re-enters the loop.
- The confirm pass retries a decode once on timeout/IO-class errors before declaring the file corrupt.
- Env vars (with defaults, read in `src/config.js`): `DOWNLOADS_DIR` (unset = fallback mode), `REMEDIATION_MAX_ATTEMPTS=3`, `REMEDIATION_QUEUE_TIMEOUT_HOURS=6`, `REMEDIATION_SEARCHING_TIMEOUT_HOURS=24`.
- New event types logged via `logEvent`: `integrity_confirm_failed`, `integrity_confirmed_clean`, `remediation_started`, `remediation_attempt`, `remediation_swapped`, `remediation_exhausted`, `remediation_fallback`.
- Every task ends with `npm test` green and a conventional commit.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/decoder.js` | Create | Whole-file ffmpeg decode, stability check for in-flight extraction, IO-retry policy |
| `src/db.js` | Modify | `remediation_episodes` table + CRUD helpers |
| `src/remediation.js` | Create | State machine + tick driver (single consumer) |
| `src/sonarr.js` | Modify | Queue detail records, blocklist-capable queue deletion, manual import command; integrity branch rewired |
| `src/config.js` | Modify | Remediation env vars |
| `src/watcher.js` | Modify | Tick the loop each poll; log new action types |
| `src/notifications.js` | Modify | Apprise event labels for new events |
| `src/routes/api.js` | Modify | `POST /api/remediation/:id/reset` (manual clear of exhausted) |
| `tests/decoder.test.js` | Create | Full-decode unit tests (real ffmpeg on tiny fixtures) |
| `tests/remediation.test.js` | Create | State machine transitions, attempt cap, timeouts (mock Sonarr + decoder) |

---

### Task 1: `src/decoder.js` — full decode + stability check

**Files:**
- Create: `src/decoder.js`
- Test: `tests/decoder.test.js`

**Interfaces:**
- Produces: `fullDecode(filePath, opts)` → `{ pass: boolean, error: string|null, retried: boolean }`; `waitForStableFile(filePath, { intervalMs, checks, maxWaitMs })` → `true` (throws on timeout); `isIoTimeoutError(err)` → boolean. Later tasks rely on exactly these signatures.

- [ ] **Step 1: Write the failing tests**

Create `tests/decoder.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../src/decoder.js'`.

- [ ] **Step 3: Implement `src/decoder.js`**

```js
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
const execFileAsync = promisify(execFile);

export function isIoTimeoutError(err) {
  if (!err) return false;
  if (err.killed && err.signal === 'SIGTERM') return true;   // child_process timeout
  if (err.code === 'ETIMEDOUT' || err.code === 'EIO') return true;
  return /timed? ?out|ETIMEDOUT|EIO/i.test(err.message || '');
}

async function decodeOnce(filePath, timeoutMs) {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-v', 'error',
      '-xerror',
      '-i', filePath,
      '-map', '0:v?', '-map', '0:a?',
      '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    if (stderr && stderr.trim()) return { pass: false, error: stderr.trim().slice(0, 2000) };
    return { pass: true, error: null };
  } catch (err) {
    return { pass: false, error: String(err.stderr || err.message).slice(0, 2000), ioTimeout: isIoTimeoutError(err) };
  }
}

/**
 * Full-stream decode. Retries once on timeout/IO errors (flaky disk, sleeping drive)
 * before declaring failure; such retries are NOT corruption evidence.
 */
export async function fullDecode(filePath, { timeoutMs = 120000, retryIoOnce = true } = {}) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (err) {
    return { pass: false, error: `File not found or unreadable: ${err.message}`, retried: false };
  }
  const first = await decodeOnce(filePath, timeoutMs);
  if (first.pass) return { pass: true, error: null, retried: false };
  if (retryIoOnce && first.ioTimeout) {
    const second = await decodeOnce(filePath, timeoutMs);
    return { pass: second.pass, error: second.error, retried: true };
  }
  return { pass: false, error: first.error, retried: false };
}

/**
 * Confirms a file being written (unpackerr extraction) has stopped growing.
 * Requires `checks` consecutive size-identical samples spaced intervalMs apart.
 */
export async function waitForStableFile(filePath, { intervalMs = 5000, checks = 2, maxWaitMs = 600000 } = {}) {
  const start = Date.now();
  let lastSize = -1;
  let stable = 0;
  while (Date.now() - start < maxWaitMs) {
    let size;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch {
      await new Promise(r => setTimeout(r, intervalMs));
      continue; // not created yet (or vanished mid-extract)
    }
    if (size > 0 && size === lastSize) {
      stable += 1;
      if (stable >= checks) return true;
    } else {
      stable = 0;
    }
    lastSize = size;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForStableFile: ${filePath} did not stabilise within ${maxWaitMs}ms`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- 2>&1 | tail -20`
Expected: PASS (all decoder tests green; existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/decoder.js tests/decoder.test.js
git commit -m "feat: full-stream decoder with IO retry and extraction stability check"
```

---

### Task 2: DB — `remediation_episodes` table + helpers

**Files:**
- Modify: `src/db.js` (schema block after the `verified_files` CREATE; helpers after `clearVerifiedFile`, ~line 293)
- Test: `tests/db.test.js` (extend)

**Interfaces:**
- Produces (all exported from `src/db.js`):
  `createRemediation({ seriesId, episodeId, showTitle, season, episode, oldFileId, reason })` → row (state `queued`),
  `getRemediation(episodeId)` → row or null,
  `setRemediationState(episodeId, state, extra)` (extra: `{ details, attempts, blockedReleases }`),
  `getActiveRemediations()` → rows in `searching|verifying|importing`,
  `getNextQueuedRemediation()` → oldest `queued` row or null,
  `resetRemediation(episodeId)` → delete row (manual clear),
  `getRemediations()` → all rows for UI.

- [ ] **Step 1: Write the failing tests** — append to `tests/db.test.js`:

```js
import { createRemediation, getRemediation, setRemediationState,
         getActiveRemediations, getNextQueuedRemediation,
         resetRemediation, getRemediations } from '../src/db.js';

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
```

- [ ] **Step 2: Run to verify failure** — `npm test -- 2>&1 | tail -10` → FAIL: `createRemediation is not a function`.

- [ ] **Step 3: Implement in `src/db.js`**

Inside the schema template, after the `verified_files` CREATE block:

```sql
    CREATE TABLE IF NOT EXISTS remediation_episodes (
      episode_id    INTEGER PRIMARY KEY,
      series_id     INTEGER NOT NULL,
      show_title    TEXT    NOT NULL,
      season        INTEGER NOT NULL,
      episode       INTEGER NOT NULL,
      old_file_id   INTEGER,
      reason        TEXT,
      state         TEXT    NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','searching','verifying','importing','swapped','exhausted')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      blocked_releases TEXT NOT NULL DEFAULT '[]',
      details       TEXT,
      state_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
```

After `clearVerifiedFile`:

```js
// Remediation state machine persistence

export function createRemediation({ seriesId, episodeId, showTitle, season, episode, oldFileId, reason }) {
  const db = getDb();
  db.prepare(`INSERT INTO remediation_episodes
    (episode_id, series_id, show_title, season, episode, old_file_id, reason, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
    ON CONFLICT(episode_id) DO NOTHING`)
    .run(episodeId, seriesId, showTitle, season, episode, oldFileId, reason);
  return getRemediation(episodeId);
}

export function getRemediation(episodeId) {
  return getDb().prepare('SELECT * FROM remediation_episodes WHERE episode_id = ?').get(episodeId) || null;
}

export function setRemediationState(episodeId, state, { details = null, attempts = null, blockedReleases = null } = {}) {
  const db = getDb();
  const row = getRemediation(episodeId);
  if (!row) return;
  db.prepare(`UPDATE remediation_episodes
    SET state = ?, state_changed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        attempts = COALESCE(?, attempts), blocked_releases = COALESCE(?, blocked_releases),
        details = COALESCE(?, details)
    WHERE episode_id = ?`)
    .run(state, attempts, blockedReleases, details, episodeId);
}

export function getActiveRemediations() {
  return getDb().prepare(`SELECT * FROM remediation_episodes
    WHERE state IN ('searching','verifying','importing') ORDER BY rowid`).all();
}

export function getNextQueuedRemediation() {
  return getDb().prepare(`SELECT * FROM remediation_episodes WHERE state = 'queued' ORDER BY rowid LIMIT 1`).get() || null;
}

export function getRemediations() {
  return getDb().prepare('SELECT * FROM remediation_episodes ORDER BY rowid DESC LIMIT 200').all();
}

export function resetRemediation(episodeId) {
  getDb().prepare('DELETE FROM remediation_episodes WHERE episode_id = ?').run(episodeId);
}
```

Note: `ON CONFLICT DO NOTHING` means re-flagging an already-remediating episode never resets its attempt counter — loop protection (spec invariant 2).

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit** — `git add src/db.js tests/db.test.js && git commit -m "feat: remediation_episodes state table + CRUD"`

---

### Task 3: Sonarr helpers — queue detail, blocklist delete, manual import

**Files:**
- Modify: `src/sonarr.js` (new exports after `searchEpisode`, ~line 375)
- Test: `tests/remediation.test.js` + `tests/helpers/sonarr-mock.js` (create both)

**Interfaces:**
- Produces:
  `getQueueRecords()` → full queue records array (id, episodeId, status, outputPath, size, trackedDownloadStatus),
  `deleteQueueItem(queueId, { removeFromClient, blocklist })`,
  `manualImportEpisode({ outputPath, episodeId })` → command record (`DownloadedEpisodesScan`),
  `getEpisodeDetail(episodeId)` → episode record (hasFile, episodeFileId).
- Consumes: `sonarrReq` (exists, private).
- Precondition to verify while implementing: `sonarrReq` must tolerate an empty 200 response body (queue DELETE returns 200 with empty body). If `response.json()` throws on empty, fix `sonarrReq` to handle empty bodies.

- [ ] **Step 1: Write failing tests** — create `tests/remediation.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSonarrMock, sonarrMockState } from './helpers/sonarr-mock.js';
import { getQueueRecords, deleteQueueItem, manualImportEpisode, getEpisodeDetail } from '../src/sonarr.js';

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
```

Create `tests/helpers/sonarr-mock.js` (network-boundary mock; verify how `sonarrReq` performs HTTP — if it uses `fetch`, this works as-is; if it uses `axios`/`undici` directly, adapt the mock to that boundary and note it in the PR description):

```js
export const sonarrMockState = { queue: [], episode: null, calls: [] };

export function installSonarrMock() {
  sonarrMockState.calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url.toString());
    const path = u.pathname.replace(/^.*\/api\/v3/, '');
    sonarrMockState.calls.push({ method: opts.method || 'GET', path, body: opts.body ? JSON.parse(opts.body) : null, query: u.search });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (opts.method === 'GET' && path === '/queue') return json({ page: 1, records: sonarrMockState.queue });
    if (opts.method === 'DELETE' && path.startsWith('/queue/')) return json({});
    if (opts.method === 'POST' && path === '/command') return json({ id: 1, status: 'queued' });
    if (opts.method === 'GET' && path === '/episode/42') return json(sonarrMockState.episode || { id: 42, hasFile: false, episodeFileId: null });
    return json({}, 404);
  };
  return () => { globalThis.fetch = realFetch; };
}
```

- [ ] **Step 2: Run to verify failure** — `npm test -- 2>&1 | tail -10` → FAIL: `getQueueRecords is not a function`.

- [ ] **Step 3: Implement in `src/sonarr.js`** (append):

```js
// --- Remediation loop helpers ---

export async function getQueueRecords() {
  const data = await sonarrReq('GET', '/queue?pageSize=500&includeEpisode=true');
  return data?.records ?? (Array.isArray(data) ? data : []);
}

export async function deleteQueueItem(queueId, { removeFromClient = true, blocklist = true } = {}) {
  const q = `removeFromClient=${removeFromClient}&blocklist=${blocklist}`;
  return sonarrReq('DELETE', `/queue/${queueId}?${q}`);
}

export async function manualImportEpisode({ outputPath, episodeId }) {
  return sonarrReq('POST', '/command', {
    name: 'DownloadedEpisodesScan',
    path: outputPath,
    episodeIds: [episodeId],
  });
}

export async function getEpisodeDetail(episodeId) {
  return sonarrReq('GET', `/episode/${episodeId}`);
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit** — `git add src/sonarr.js tests/ && git commit -m "feat: sonarr queue-detail, blocklist delete, manual import helpers"`

---

### Task 4: `src/remediation.js` — state machine + tick driver

**Files:**
- Create: `src/remediation.js`
- Test: `tests/remediation.test.js` (extend)

**Interfaces:**
- Produces: `tickRemediations()` → runs one pass; `startRemediation({ episodeId, seriesId, showTitle, season, episode, oldFileId, reason })` → creates row (respecting concurrency) or null (fallback used); `resolveDownloadPath(sonarrPath)` → local path via `DOWNLOADS_DIR` prefix mapping (reuses `resolveLocalPath` from prober.js).
- Consumes: `fullDecode`, `waitForStableFile` (decoder.js); DB helpers (Task 2); Sonarr helpers (Task 3); `searchEpisode`, `deleteEpisodeFile`, `getEpisodeFile`, `resolveLocalPath`; `logEvent`, `getSetting` from db.js; `sendAppriseNotification` from notifications.js.

State transitions implemented (exactly):

```
queued      -> searching     (when picked by tick, concurrency slot free)
searching   -> verifying     (completed queue record for episodeId found)
searching   -> searching     (attempt++ if stale, blocklisted, re-search)
searching   -> exhausted     (attempts >= max OR no completed record within searching timeout)
verifying   -> importing     (fullDecode pass on stable queued file)
verifying   -> searching     (fullDecode fail: queue deleted w/ blocklist, attempt++, re-search)
verifying   -> exhausted     (fullDecode fail and attempts+1 >= max)
importing   -> swapped       (post-import fullDecode pass on final /tv path)
importing   -> swapped       (post-import fail: NOTIFIED, still terminal — spec invariant 4)
importing   -> importing     (old episodeFile delete or import command fails: retry next tick)
```

- [ ] **Step 1: Write failing tests** — extend `tests/remediation.test.js`:

```js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { startRemediation, tickRemediations } from '../src/remediation.js';
import { createRemediation, getRemediation, setRemediationState, resetRemediation } from '../src/db.js';

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

function setPaths({ dlDir, mediaDir }) {
  process.env.DOWNLOADS_DIR = '/downloads';
  process.env.SONARR_PATH_PREFIX = '/data/Downloads';
  process.env.EG_MEDIA_PREFIX = mediaDir || '/tv';
  process.env.SONARR_MEDIA_PREFIX = '/data/TV';
}

test('startRemediation queues second episode behind the first', async () => {
  const restore = installSonarrMock();
  try {
    sonarrMockState.episode = { id: 42, hasFile: true, episodeFileId: 7 };
    await startRemediation({ episodeId: 42, seriesId: 1, showTitle: 'Sunny', season: 12, episode: 3,
      oldFileId: 7, reason: 'corrupt_stream' });
    await startRemediation({ episodeId: 43, seriesId: 1, showTitle: 'Sunny', season: 12, episode: 4,
      oldFileId: 8, reason: 'corrupt_stream' });
    await tickRemediations();
    assert.equal(getRemediation(42).state, 'searching');
    assert.equal(getRemediation(43).state, 'queued');
  } finally { resetRemediation(42); resetRemediation(43); restore(); }
});

test('verifying -> importing -> swapped with clean queued file', async () => {
  const restore = installSonarrMock();
  try {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-dl-'));
    setPaths({ dlDir });
    const queued = makeMedia(dlDir, 'sunny.s12e03.mkv');
    sonarrMockState.episode = { id: 42, hasFile: true, episodeFileId: 7 };
    sonarrMockState.queue = [{ id: 5, episodeId: 42, status: 'completed',
      outputPath: '/data/Downloads/tv/sunny.s12e03.mkv', trackedDownloadStatus: 'ImportPending', size: fs.statSync(queued).size }];

    createRemediation({ seriesId: 1, episodeId: 42, showTitle: 'Sunny', season: 12, episode: 3,
      oldFileId: 7, reason: 'corrupt_stream' });
    setRemediationState(42, 'searching');

    await tickRemediations(); // searching -> verifying -> importing (clean file)
    assert.equal(getRemediation(42).state, 'importing');
    assert.ok(sonarrMockState.calls.some(c => c.method === 'POST' && c.path === '/command' && c.body.name === 'DownloadedEpisodesScan'));
    // delete of the OLD file must have happened in the importing tick (after verify)
    assert.ok(sonarrMockState.calls.some(c => c.method === 'DELETE' && /episodefile\/7/.test(c.path)));
    assert.equal(sonarrMockState.calls.filter(c => c.method === 'DELETE' && /episodefile/.test(c.path)).length, 1);

    // after import Sonarr reports the new file; final decode passes
    sonarrMockState.episode = { id: 42, hasFile: true, episodeFileId: 99 };
    sonarrMockState.episodeFile = { id: 99, path: '/data/TV/Sunny/Season 12/sunny.s12e03.mkv' };
    sonarrMockState.fetchFileBytes = () => fs.readFileSync(queued); // final path maps onto queued bytes
    await tickRemediations(); // importing -> swapped
    assert.equal(getRemediation(42).state, 'swapped');
  } finally { resetRemediation(42); restore(); }
});

test('corrupt queued files are blocklisted, attempts increment, exhaust at cap', async () => {
  const restore = installSonarrMock();
  try {
    const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-dl2-'));
    setPaths({ dlDir });
    // corrupt the fixture via size mutation: real corruption comes from ffmpeg-generated file
    sonarrMockState.corruptOutputPath = true; // helper flag consumed by mock setup below
    createRemediation({ seriesId: 1, episodeId: 42, showTitle: 'Sunny', season: 12, episode: 3, oldFileId: 7, reason: 'x' });
    setRemediationState(42, 'searching');

    for (let i = 0; i < 5; i++) {
      // each attempt: a fresh corrupt file at a distinct release path
      const bad = makeMedia(dlDir, `rel${i}.mkv`, { corrupt: true });
      sonarrMockState.queue = [{ id: 100 + i, episodeId: 42, status: 'completed',
        outputPath: `/data/Downloads/tv/rel${i}.mkv`, trackedDownloadStatus: 'ImportPending', size: fs.statSync(bad).size }];
      sonarrMockState.fileBytes = fs.readFileSync(bad);
      await tickRemediations();
    }
    const row = getRemediation(42);
    assert.equal(row.state, 'exhausted');
    assert.ok(row.attempts >= 3);
    const blockDeletes = sonarrMockState.calls.filter(c => c.method === 'DELETE' && c.path.includes('blocklist=true'));
    assert.ok(blockDeletes.length >= 3);
    // old file NEVER deleted in a failed loop (it was still the only copy)
    assert.equal(sonarrMockState.calls.filter(c => c.method === 'DELETE' && /episodefile/.test(c.path)).length, 0);
  } finally { resetRemediation(42); restore(); }
});
```

Note on file-bytes mocking: the queued file lives at `resolveDownloadPath(outputPath)` on disk in the temp dir (the mock maps `/data/Downloads` -> `process.env.DOWNLOADS_DIR`-mounted temp dir by creating real files there — tests write the actual files so `fullDecode` runs real ffmpeg; no byte-fetch mocking needed; delete the `sonarrMockState.fetchFileBytes/fileBytes` lines if the implementation reads from disk, which it should).

- [ ] **Step 2: Run to verify failure** — FAIL: module `../src/remediation.js` not found.

- [ ] **Step 3: Implement `src/remediation.js`**

```js
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
    media: { sonarr: process.env.SONARR_MEDIA_PREFIX || getSetting('sonarr_path_prefix') || '/data/TV',
             local: process.env.EG_MEDIA_PREFIX || getSetting('local_path_prefix') || '/tv' },
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
    await sendAppriseNotification('remediation', { showTitle: rem.show_title, season: rem.season,
      episode: rem.episode, details: message });
  } catch { /* apprise failures never block the loop */ }
}

export async function startRemediation({ episodeId, seriesId, showTitle, season, episode, oldFileId, reason }) {
  const existing = getRemediation(episodeId);
  if (existing && existing.state !== 'exhausted' && existing.state !== 'swapped') return existing;

  if (!downloadsDir()) {
    // Documented fallback: delete-first, as today, with explicit notice.
    try { await deleteEpisodeFile(oldFileId); await searchEpisode(episodeId); } catch { /* logged below */ }
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
      try { await deleteEpisodeFile(rem.old_file_id); }
      catch (err) {
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
  try { await waitForStableFile(local, { intervalMs: 5000, checks: 2, maxWaitMs: 120000 }); }
  catch { return; }
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

export async function tickRemediations() {
  const active = getActiveRemediations();
  for (const rem of active) {
    const row = getRemediation(rem.episode_id); // fresh read: state may change mid-tick
    try {
      if (row.state === 'searching') await tickSearching(row);
      else if (row.state === 'verifying') await tickVerifying(row);
      else if (row.state === 'importing') await tickImporting(row);
    } catch (err) {
      console.error(`[remediation] tick error for episode ${row.episode_id}:`, err.message);
      logAction(row, 'error', { message: 'remediation tick error: ' + err.message });
    }
  }
  // Promote one queued episode if no searching/verifying/importing slot is used.
  const stillActive = getActiveRemediations();
  if (stillActive.length === 0) {
    const next = getNextQueuedRemediation();
    if (next) {
      setRemediationState(next.episode_id, 'searching');
      try { await searchEpisode(next.episode_id); }
      catch (err) {
        setRemediationState(next.episode_id, 'queued'); // retry promotion next tick
        console.error('[remediation] search trigger failed:', err.message);
      }
    }
  }
}
```

Implementation notes:
- The old-file delete happens in `importing` only after `verifying` passed `fullDecode` — the single delete-per-remediation assertion in the test enforces it.
- `rem.details.startsWith('verified ')` distinguishes "first tick in importing" from "post-import verify" ticks; if that string-typing proves fragile during implementation, replace with a dedicated `phase` column (`swap_pending` / `verify_final`) — small schema addition, same transitions.

- [ ] **Step 4: Run tests** — `npm test` → PASS (expect 2-3 iterations on timing/mocking details; the tests are the contract).

- [ ] **Step 5: Commit** — `git add src/remediation.js tests/ && git commit -m "feat: remediation state machine and tick driver"`

---

### Task 5: Rewire the integrity branch + wire the tick

**Files:**
- Modify: `src/sonarr.js` (~lines 183-202, the `integrityMode === 'auto_remediate'` block)
- Modify: `src/watcher.js` (add tick call at end of `runWatcher` ~line 183; add activity-log branches ~line 226; pass `series` into `ensureUpcomingEpisodes` if needed for show title)
- Test: `tests/remediation.test.js` (extend)

**Interfaces:**
- Consumes: `startRemediation`, `tickRemediations` (Task 4); `fullDecode` (Task 1).
- Produces: no new exports; behaviour change only.

- [ ] **Step 1: Write the failing test** — add to `tests/remediation.test.js`:

```js
test('startRemediation records the loop when downloads dir is set; falls back without it', async () => {
  const restore = installSonarrMock();
  try {
    process.env.DOWNLOADS_DIR = '/downloads';
    sonarrMockState.episode = { id: 44, hasFile: true, episodeFileId: 9 };
    const row = await startRemediation({ episodeId: 44, seriesId: 1, showTitle: 'Sunny', season: 12, episode: 5,
      oldFileId: 9, reason: 'corrupt_stream: boom' });
    assert.equal(row.state, 'queued');

    // fallback: no downloads dir -> old file deleted immediately + search
    const prevDl = process.env.DOWNLOADS_DIR;
    delete process.env.DOWNLOADS_DIR;
    sonarrMockState.calls = [];
    const row2 = await startRemediation({ episodeId: 45, seriesId: 1, showTitle: 'Sunny', season: 12, episode: 6,
      oldFileId: 10, reason: 'corrupt_stream: boom' });
    assert.equal(row2, null);
    assert.ok(sonarrMockState.calls.some(c => c.method === 'DELETE' && /episodefile\/10/.test(c.path)));
    process.env.DOWNLOADS_DIR = prevDl;
  } finally { resetRemediation(44); resetRemediation(45); restore(); }
});
```

- [ ] **Step 2: Rewire `src/sonarr.js`** — replace the `integrityMode === 'auto_remediate'` block with:

```js
      if (integrityMode === 'auto_remediate') {
        // Confirm pass: full decode before anything is deleted (spec).
        const confirm = await fullDecode(localPath, { timeoutMs: 300000 });
        if (confirm.pass) {
          // Tier 1/2 was a false positive (e.g. -ss tail artifact).
          markEpisodeFileVerified(ep.episodeFileId, 'valid', { runtime: probeResult.actualDurationSec, details: 'confirmed clean via full decode' });
          actions.push({
            episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
            action: 'integrity_confirmed_clean',
            details: `Tail probe flagged this file, full decode passed (${probeResult.reason}) - no action`,
          });
          continue;
        }
        clearVerifiedFile(ep.episodeFileId);
        const row = await startRemediation({
          episodeId: ep.id, seriesId: seriesId,
          showTitle: ep.seriesTitle || '',
          season: ep.seasonNumber, episode: ep.episodeNumber,
          oldFileId: ep.episodeFileId,
          reason: `${probeResult.reason}: ${probeResult.details}; confirm decode: ${confirm.error}`,
        });
        if (row) {
          actions.push({
            episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
            action: 'remediation_started',
            details: `Confirmed corrupt (${confirm.error}). Keeping current file, searching for verified replacement.`,
          });
        } else if (!process.env.DOWNLOADS_DIR) {
          actions.push({
            episodeId: ep.id, season: ep.seasonNumber, episode: ep.episodeNumber,
            action: 'remediated_corrupt_file',
            details: `${probeResult.reason}: ${probeResult.details}. Fallback delete-first (no downloads mount).`,
          });
        }
      }
```

Notes:
- `ensureUpcomingEpisodes` receives only `seriesId`; show title is available at the caller (`watcher.js` has `series` and `ep`). Extend the signature to `ensureUpcomingEpisodes(seriesId, season, episode, preloaded, queuedEpisodeIds, series)` and pass `series` from both call sites in `src/watcher.js` (`processEpisode` already fetches it); use `series.title`. If `ep.seriesTitle` is absent, use `series.title` directly.
- Add imports at the top of `src/sonarr.js`: `import { fullDecode } from './decoder.js';` and `import { startRemediation } from './remediation.js';`. Circular import risk: `remediation.js` imports `sonarr.js`. ESM handles cycles for function-declaration exports, but if node throws at load, use a lazy `const { startRemediation } = await import('./remediation.js');` inside the branch and note it in the commit message.
- Notify-Only mode stays untouched.
- New imports in `sonarr.js` must also bring `logEvent` usage for `integrity_confirm_failed` — the confirm-failure event is emitted by `startRemediation` via `remediation_started`/`remediation_fallback`, so no extra logging is needed here.

- [ ] **Step 3: Wire the tick in `src/watcher.js`** — at the end of `runWatcher()` (after the `processed` pruning loop):

```js
  // Drive any active remediation loops
  try {
    const { tickRemediations } = await import('./remediation.js');
    await tickRemediations();
  } catch (err) {
    console.error('[watcher] Remediation tick error:', err.message);
  }
```

Dynamic import avoids the ESM circular-load issue entirely.

- [ ] **Step 4: Extend the activity logging in `src/watcher.js`** — alongside the existing `remediated_corrupt_file` branch:

```js
    } else if (a.action === 'remediation_started') {
      logEvent({ event_type: 'remediation_started', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: a.details || 'Remediation loop started', trigger } });
    } else if (a.action === 'integrity_confirmed_clean') {
      logEvent({ event_type: 'integrity_confirmed_clean', show_title: showTitle, season: epSeason, episode: epEpisode,
        details: { message: a.details || 'Full decode confirmed the file is clean', trigger } });
    }
```

(`remediation_attempt`, `remediation_swapped`, `remediation_exhausted`, `remediation_fallback` are emitted directly by `remediation.js` via `logAction`, so they land in the activity feed without watcher changes.)

- [ ] **Step 5: Run tests** — `npm test` → PASS.

- [ ] **Step 6: Commit** — `git add -A src/ tests/ && git commit -m "feat: integrity branch enters verify-before-swap loop; watcher drives remediation"`

---

### Task 6: Config + notifications + manual reset route

**Files:**
- Modify: `src/config.js` (env surface)
- Modify: `src/notifications.js` (apprise labels + whitelist handling)
- Modify: `src/routes/api.js` (reset endpoint, GET list)
- Test: `tests/remediation.test.js` (extend)

**Interfaces:**
- Produces: documented env config; apprise labels for new event types; `POST /api/remediation/:episodeId/reset`; `GET /api/remediation`.

- [ ] **Step 1: Config** — add to `src/config.js` after `dataDir`:

```js
  downloadsDir: process.env.DOWNLOADS_DIR || '',
  remediationMaxAttempts: parseInt(process.env.REMEDIATION_MAX_ATTEMPTS ?? '3', 10),
  remediationQueueTimeoutHours: parseInt(process.env.REMEDIATION_QUEUE_TIMEOUT_HOURS ?? '6', 10),
  remediationSearchingTimeoutHours: parseInt(process.env.REMEDIATION_SEARCHING_TIMEOUT_HOURS ?? '24', 10),
```

Note: `remediation.js` reads these env vars directly (Task 4) for testability; `config.js` is the documented surface for compose. Do not unify the parsing.

- [ ] **Step 2: Notifications** — in `src/notifications.js`, add a label map and whitelist handling:

```js
  const LABELS = {
    remediation_started:        'Corrupt episode: replacement search started',
    remediation_attempt:        'Corrupt episode: replacement failed validation',
    remediation_swapped:        'Corrupt episode: replaced with verified copy',
    remediation_exhausted:      'Corrupt episode: gave up after max releases',
    remediation_fallback:       'Corrupt episode: delete-first fallback used',
    integrity_confirm_failed:   'Corrupt episode confirmed by full decode',
    integrity_confirmed_clean:  'Integrity flag cleared by full decode',
  };
```

`sendAppriseNotification('remediation', ...)` is called by `remediation.js`. The `apprise_events` whitelist (line ~16) is exact-match per event type today; make `'remediation'` match any `remediation_*` event (prefix match) and document it in the label map comment. Add a unit test for the whitelist function if it is exported; if it is inline, extract it into an exported `shouldNotify(eventType)` helper and test that.

- [ ] **Step 3: Reset route** — in `src/routes/api.js`, matching the neighbouring endpoint style exactly (read the file first; do not invent a router style):

```js
import { resetRemediation, getRemediations } from '../db.js';

router.post('/remediation/:episodeId/reset', (req, res) => {
  const id = parseInt(req.params.episodeId, 10);
  if (!getRemediations().some(r => r.episode_id === id)) {
    return res.status(404).json({ error: 'not found' });
  }
  resetRemediation(id);
  res.json({ ok: true });
});
router.get('/remediation', (req, res) => {
  res.json(getRemediations());
});
```

- [ ] **Step 4: Test** — extend `tests/remediation.test.js`:

```js
test('resetRemediation clears an exhausted row', () => {
  createRemediation({ seriesId: 1, episodeId: 99, showTitle: 'S', season: 1, episode: 2, oldFileId: 5, reason: 'x' });
  setRemediationState(99, 'exhausted', { attempts: 3 });
  resetRemediation(99);
  assert.equal(getRemediation(99), null);
});
```

- [ ] **Step 5: Run tests** — `npm test` → PASS.

- [ ] **Step 6: Commit** — `git add -A src tests && git commit -m "feat: remediation config, apprise labels, manual reset endpoint"`

---

### Task 7: README + verification run

**Files:**
- Modify: `README.md` (media-integrity section)

- [ ] **Step 1: README** — in "Media file integrity checking & auto-remediation", replace the Auto-Remediation bullet:

```markdown
3. **Auto-Remediation (verify before swap):** A flagged file first gets a full-stream
   decode to confirm it is genuinely corrupt. If confirmed, Episode Guard keeps the
   current file and asks Sonarr for a replacement. The replacement is full-decoded in
   the downloads folder before anything is touched; only then is the old file swapped
   out via Sonarr manual import, and the final file is decoded once more. Failed
   replacements are blocklisted, up to 3 different releases, then a summary alert.
   Falls back to the old delete-first behaviour (with a warning) if the downloads
   folder is not mounted. Exhausted remediations can be cleared via
   `POST /api/remediation/:episodeId/reset`.
```

Add the compose mount line + env entry:

```yaml
  - /data/Downloads:/downloads:ro   # downloads root incl. unpackerr output
```

```yaml
      DOWNLOADS_DIR: /downloads      # enables verify-before-swap; omit = delete-first fallback
      REMEDIATION_MAX_ATTEMPTS: 3
```

- [ ] **Step 2: Full test run** — `npm test` → PASS, zero failures.

- [ ] **Step 3: Commit** — `git add README.md && git commit -m "docs: verify-before-swap remediation in README"`

- [ ] **Step 4: Manual end-to-end (after Nav rebuilds the container with the new mount)** — trigger on the live Sunny S11-S13 backlog:
  1. Set `integrity_check_mode=auto_remediate`, mount `/data/Downloads:/downloads:ro`, set `DOWNLOADS_DIR=/downloads`.
  2. Watch the activity feed: expect `remediation_started` -> `verifying` -> `importing` -> `remediation_swapped`, and exactly one `episodefile` delete per episode, never before `verifying` passed.
  3. Confirm in Sonarr UI: old file gone only at import time; new file imported same quality.

## Verification

- `npm test` green after every task.
- Integration expectations pinned by `tests/remediation.test.js`: no `episodefile` DELETE before a queued file passes decode; blocklist DELETE for each failed attempt; exhausted at 3; concurrency serialisation; old file never deleted in a failed loop.
- Manual loop on the live backlog (Task 7 step 4) is the acceptance gate.
