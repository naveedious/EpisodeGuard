# Integrity remediation loop: verify before swap

Date: 2026-09-20
Status: approved design, pending implementation plan

## Problem

The current auto-remediation deletes a corrupt `episodeFile` in Sonarr, then triggers a replacement search. If the search is slow, produces another corrupt download, or fails outright, the episode is simply missing. In practice the media server ended up with no file and no warning until the next integrity pass.

Real-world trigger: the daily log sweep flagged 45 integrity errors across ~15 distinct episodes (It's Always Sunny S11-S13, Chicago P.D.). Some of those flags come from the Tier 2 tail decode (the `-ss` decode of the final 30 seconds), which can report a failure on files that decode fine end to end. Today that ambiguity can lead to deleting a file that was never actually broken.

## Goal

Replace delete-first remediation with a verify-before-swap loop:

1. Confirm a flagged file is genuinely corrupt with a full decode.
2. Get a replacement downloaded, still keeping the old file on disk.
3. Full-decode the replacement before it replaces anything.
4. Only swap after the replacement passes.
5. Give up cleanly after 3 different releases and say so.

No moment in this loop should leave the episode with no file on disk.

## Scope

Watch-ahead (upcoming) episodes only, matching the existing integrity-check scope. Library-wide auditing is out of scope for this feature.

## Current state (what exists today)

- Tier 1: physical duration vs Sonarr metadata, tolerance `< 80%` of expected.
- Tier 2: `ffprobe` plus a 30-second tail decode to `/dev/null`, run only when media storage is mounted.
- `integrity_check_mode`: `Auto-Remediate` (delete + re-search now) or `Notify Only`.
- Verification cache in SQLite so clean files are not re-probed.
- Sonarr API client, Apprise notifications, activity feed UI.

## Design

### Pipeline

```
flagged by Tier 1 or Tier 2
  -> CONFIRM: full decode of the whole file (ffmpeg -f null -)
       pass  -> clear the flag, cache result, done
       fail  -> enter remediation state
  -> SEARCH: trigger a Sonarr episode search, keep the old file
  -> VERIFY: poll the Sonarr queue; when the download for this episode
             reaches a completed state, full-decode the queued file
       clean -> SWAP: delete the old episodeFile in Sonarr, let Sonarr
                      import the replacement, re-verify from cache
       corrupt -> remove the queue item with blocklist=true, retry
  -> after 3 blocked releases: EXHAUSTED, notify-only summary
```

### Full decode

One function, used for both the confirm pass and the replacement verify:

- `ffmpeg -i <file> -f null -` over the entire file, audio and video streams, error log captured.
- Timeout scaled to file length (default: expected duration + 5 minutes, capped).
- Result recorded in the verification cache keyed by file path + size + mtime, so a queued download is never decoded twice.

### Delete-after guarantee

The old `episodeFile` is deleted only after a verified clean replacement exists. Enforced in one place (the swap step). Every other code path that can remove files today keeps existing behaviour, but the remediation loop itself never deletes first.

### Release dedup

Each failed attempt adds a Sonarr blocklist entry (`removeFromClient: true, blocklist: true` on queue deletion). Attempt N+1 therefore picks a different release. Attempt counter and failed release IDs stored per episode in the remediation state.

### State machine (SQLite, per episode)

`suspect -> confirmed -> searching -> verifying -> swapped | exhausted`

- Rows survive container restarts; the watcher resumes polling on boot.
- Any queue item stuck in a non-completed state longer than `REMEDIATION_QUEUE_TIMEOUT_HOURS` (default: 6) counts as a failed attempt: remove with blocklist, retry.
- If Sonarr reports the download failed before completion, same handling.

### Fallback

If the completed-downloads directory is not mounted (or the queue item's `outputPath` is unreadable), the loop cannot verify the replacement. In that case it falls back to today's delete-first behaviour and says so explicitly in the Apprise notification and the activity row. Silent degradation is not acceptable.

### Configuration

New env vars, all with sane defaults so the feature works without touching compose:

| Var | Default | Purpose |
|---|---|---|
| `DOWNLOADS_DIR` | unset | Read-only mount of the download client's completed folder; presence enables queue-file verification |
| `REMEDIATION_MAX_ATTEMPTS` | `3` | Distinct releases tried before exhausted |
| `REMEDIATION_QUEUE_TIMEOUT_HOURS` | `6` | Stuck queue item treated as failed |

Existing `integrity_check_mode` keeps its two values; the verify-before-swap loop replaces what `Auto-Remediate` does internally. No new mode names to configure.

### Mounting (deploy side)

EpisodeGuard already mounts `/tv:ro`. Deployment adds one line so queued downloads can be probed:

```yaml
volumes:
  - ./data:/data
  - /data/TV:/tv:ro
  - /data/Downloads:/downloads:ro   # completed folder of the download client
```

`DOWNLOADS_DIR=/downloads` then points the verifier at the right place. If Sonarr's queue item gives an absolute path that starts with a different mount point, the code maps the `outputPath` prefix onto this mount rather than requiring identical paths.

### UI and notifications

- Activity rows show the loop state (`confirming`, `verifying`, `swapped`, `exhausted`) and per-attempt detail in the plain-English details column.
- Apprise messages: one on confirmed-corrupt (with full-decode result), one on successful swap, one on exhaustion listing all 3 blocked releases.
- No new UI pages; the existing activity feed carries it.

### Interactions and error handling

- Sonarr unreachable during the loop: poll retries with backoff, state unchanged, logged.
- The swap step deletes the old file via the existing Sonarr API path; if that call fails after the replacement is verified, log the error and retry the delete on the next poll cycle (the verified queued file stays queued; Sonarr still holds it).
- Old file already gone when the swap step runs (user deleted it manually): proceed with import only.
- Verification cache hits never skip a remediation decision; cache only short-circuits re-decoding the same unchanged file.

### Testing

- Unit: state transitions, attempt counting, blocklist calls, timeout handling, path-prefix mapping.
- Integration (mock Sonarr + a real ffmpeg run on a sample broken MP4): confirm pass rejects the broken file, accepts a healthy one, swap only happens after verify passes.
- Manual: run against the live Sunny/Chicago P.D. backlog once implemented, watch one full loop end to end.

## Out of scope

- Library-wide audits.
- Movies (Sonarr-only today).
- Re-encoding or repairing corrupt files.
