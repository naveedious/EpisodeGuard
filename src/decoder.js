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
 * Full-stream decode. Retries once on timeout/IO errors with a doubled timeout
 * before declaring failure; such retries are NOT corruption evidence.
 * Result.timeout === true means "inconclusive (timed out)", never "corrupt".
 */
export async function fullDecode(filePath, { timeoutMs = 120000, retryIoOnce = true } = {}) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (err) {
    return { pass: false, error: `File not found or unreadable: ${err.message}`, retried: false };
  }
  const first = await decodeOnce(filePath, timeoutMs);
  if (first.pass) return { pass: true, error: null, retried: false, timeout: false };
  if (retryIoOnce && first.ioTimeout) {
    // Retry with a doubled timeout: slow CPU + large files is the common
    // cause, and a timeout is NOT corruption evidence (Taskmaster S22E03).
    const second = await decodeOnce(filePath, timeoutMs * 2);
    return { pass: second.pass, error: second.error, retried: true, timeout: !second.pass && !!second.ioTimeout };
  }
  return { pass: false, error: first.error, retried: false, timeout: !!first.ioTimeout };
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
