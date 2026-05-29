# episode-guard

Polls Tautulli for playing TV episodes. For each, ensures Sonarr has the next N episodes monitored and grabbed. Auto-adds shows missing from Sonarr.

## How it works

1. Every `POLL_INTERVAL_SECONDS` seconds, fetch active Tautulli sessions
2. Discard non-episode media (movies, music)
3. For each playing episode:
   - Locate series in Sonarr (by TVDB id → title fallback)
   - If not in Sonarr → add it, monitor + search current season
   - Check next `LOOKAHEAD_EPISODES` episodes after the playing one
   - Monitor any unmonitored episodes
   - Trigger `EpisodeSearch` for any not yet on disk

## Quick start

```bash
cp .env.example .env
# edit .env with your API keys
docker compose up -d
```

## Config

| Variable | Required | Default | Description |
|---|---|---|---|
| `TAUTULLI_URL` | ✓ | — | e.g. `http://tautulli:8181` |
| `TAUTULLI_API_KEY` | ✓ | — | Tautulli Settings → Web Interface |
| `SONARR_URL` | ✓ | — | e.g. `http://sonarr:8989` |
| `SONARR_API_KEY` | ✓ | — | Sonarr Settings → General |
| `POLL_INTERVAL_SECONDS` | | `300` | Seconds between polls |
| `LOOKAHEAD_EPISODES` | | `5` | Episodes ahead to ensure are ready |
| `SONARR_QUALITY_PROFILE_ID` | | `1` | Quality profile for auto-added shows |
| `SONARR_ROOT_FOLDER` | | `/tv` | Root folder for auto-added shows |

## Find your Sonarr quality profile IDs

```
curl "http://sonarr:8989/api/v3/qualityprofile?apikey=YOUR_KEY"
```

## Building

```bash
docker build -t episode-guard .
```

No npm install needed — zero npm dependencies (uses Node built-in `fetch`).
