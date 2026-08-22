import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Resolves a Sonarr-reported remote path to the local container path using prefix mapping.
 */
export function resolveLocalPath(sonarrPath, sonarrPrefix, localPrefix) {
  if (!sonarrPath || !sonarrPrefix || !localPrefix) return sonarrPath;
  
  const normSonarr = path.normalize(sonarrPath);
  const normPrefix = path.normalize(sonarrPrefix);
  
  if (normSonarr.startsWith(normPrefix)) {
    const rel = normSonarr.slice(normPrefix.length).replace(/^[/\\]+/, '');
    return path.join(path.normalize(localPrefix), rel);
  }
  
  return sonarrPath;
}

/**
 * Evaluates duration and stream error findings against expected runtime and tolerance.
 */
export function evaluateIntegrity({ actualDurationSec, expectedRuntimeSec, tolerancePercent = 80, streamError = null }) {
  if (streamError) {
    return {
      valid: false,
      reason: 'corrupt_stream',
      details: String(streamError).trim(),
    };
  }

  if (expectedRuntimeSec && expectedRuntimeSec > 0 && actualDurationSec && actualDurationSec > 0) {
    const minAllowedSec = Math.floor((expectedRuntimeSec * tolerancePercent) / 100);
    if (actualDurationSec < minAllowedSec) {
      return {
        valid: false,
        reason: 'runtime_too_short',
        details: `Actual duration (${Math.round(actualDurationSec)}s) is below ${tolerancePercent}% of expected (${Math.round(expectedRuntimeSec)}s, min ${minAllowedSec}s)`,
      };
    }
  }

  return {
    valid: true,
    reason: 'ok',
    details: `Duration: ${Math.round(actualDurationSec || 0)}s, stream decode clean`,
  };
}

/**
 * Probes media file with ffprobe for duration and ffmpeg for tail decode check.
 * Strictly bounded in memory and execution time.
 */
export async function probeMediaFile(filePath, {
  expectedRuntimeSec = null,
  tolerancePercent = 80,
  tailSeconds = 30,
  timeoutMs = 15000,
} = {}) {
  // Check file readability
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (err) {
    return {
      available: false,
      valid: false,
      reason: 'file_inaccessible',
      details: `File not found or unreadable: ${err.message}`,
    };
  }

  let actualDurationSec = null;

  // Step 1: ffprobe format and stream duration
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB buffer cap
    });

    const parsed = JSON.parse(stdout);
    if (parsed.format && parsed.format.duration) {
      actualDurationSec = parseFloat(parsed.format.duration);
    }
  } catch (err) {
    return {
      available: true,
      valid: false,
      reason: 'corrupt_stream',
      details: `ffprobe failed to read container: ${err.message}`,
    };
  }

  // Step 2: Tail decode check via ffmpeg
  let streamError = null;
  if (actualDurationSec && actualDurationSec > 5) {
    const seekSec = Math.max(0, Math.floor(actualDurationSec - tailSeconds));
    try {
      // Decode last N seconds to null
      await execFileAsync('ffmpeg', [
        '-v', 'error',
        '-ss', String(seekSec),
        '-i', filePath,
        '-f', 'null',
        '-',
      ], {
        timeout: timeoutMs,
        maxBuffer: 512 * 1024,
      });
    } catch (err) {
      // Non-empty stderr or error return
      streamError = err.stderr || err.message;
    }
  }

  const evalResult = evaluateIntegrity({
    actualDurationSec,
    expectedRuntimeSec,
    tolerancePercent,
    streamError,
  });

  return {
    available: true,
    actualDurationSec,
    ...evalResult,
  };
}
