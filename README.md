# Episode Guard

> A ferret that makes sure your next episode is ready before you want to watch it.

Episode Guard watches Tautulli for what you're playing and tells Sonarr to grab the next episodes before you get there. No more finishing an episode and finding the next one isn't downloaded.

---

## How it works

Every time Tautulli sees you watching a TV episode, Episode Guard:

1. Checks whether the current episode is on disk — if not, triggers a search immediately
2. Looks ahead a configurable number of episodes and grabs anything missing
3. Near the end of a season, checks the next season:
   - If it hasn't aired yet, marks it monitored so Sonarr picks it up automatically on release
   - If it's already airing and episodes are missing, searches for them directly (bypasses monitored status)
4. Sends a notification via Apprise for anything it acts on

You can also point Tautulli webhooks at Episode Guard so it reacts the moment you press play, rather than waiting for the next poll.

---

## Activity log — what each status means

| Status | What happened |
|---|---|
| **Webhook** | A webhook came in from Tautulli — Episode Guard woke up because you started playing something |
| **Confirmed** | The current episode was already on disk, nothing to do |
| **Grabbed** | Episode Guard triggered a search in Sonarr for a missing episode |
| **Monitored** | An upcoming episode wasn't monitored in Sonarr — Episode Guard fixed that so it gets grabbed automatically when it airs |
| **Season Monitored** | The next season hasn't aired yet — Episode Guard marked it monitored so Sonarr picks it up on release |
| **Error** | Something went wrong — check the details column for what failed |

---

## Quick start

```bash
cp .env.example .env
# fill in your API keys
docker compose up -d
```

Open `http://localhost:3000` for the dashboard.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TAUTULLI_URL` | yes | — | e.g. `http://tautulli:8181` |
| `TAUTULLI_API_KEY` | yes | — | Tautulli → Settings → Web Interface |
| `SONARR_URL` | yes | — | e.g. `http://sonarr:8989` |
| `SONARR_API_KEY` | yes | — | Sonarr → Settings → General |

---

## In-app settings

Configured via the dashboard Settings tab (stored in SQLite, not env vars):

| Setting | Default | What it does |
|---|---|---|
| `poll_interval_seconds` | 300 | How often to poll Tautulli. Bumps to 600 automatically when webhook mode is on |
| `lookahead_episodes` | 3 | How many upcoming episodes to check and grab ahead of what you're watching |
| `season_end_buffer` | 3 | Episodes from the finale before checking the next season |
| `log_retention_days` | 30 | How long to keep activity log entries |
| `apprise_url` | — | Apprise endpoint for notifications |
| `apprise_events` | `episode_grabbed` | Comma-separated events to notify on: `episode_grabbed`, `episode_monitored`, `season_monitored`, `error` |
| `webhook_enabled` | off | React on play via webhook — polling becomes a fallback |

---

## Tautulli webhook setup

Settings → Notification Agents → add Webhook. URL: `http://your-episode-guard:3000/api/webhook`, trigger on **Playback Start**.

JSON body:

```json
{
  "media_type": "{media_type}",
  "grandparent_title": "{grandparent_title}",
  "parent_media_index": "{parent_media_index}",
  "media_index": "{media_index}",
  "grandparent_guids": {grandparent_guids}
}
```

---

## Building

```bash
docker build -t episode-guard .
```

No npm install needed — uses Node's built-in `fetch`.
