# Episode Guard

> A ferret that makes sure your next episode is ready before you want to watch it.

Episode Guard watches Tautulli for what you're playing and tells Sonarr to grab upcoming episodes before you get there. No more finishing an episode and finding the next one isn't downloaded.

---

## How it works

Every time Tautulli sees you watching a TV episode, Episode Guard:

1. Checks whether the current episode is on disk — if not, kicks off a search immediately
2. Looks ahead a configurable number of episodes and grabs anything missing
3. Near the end of a season, checks what's next:
   - If the next season hasn't aired yet, marks it monitored so Sonarr picks it up on release
   - If it's already airing with missing episodes, searches by episode ID directly (ignores monitored status)
4. Sends a notification via Apprise for anything it acts on

You can also point Tautulli webhooks at Episode Guard so it reacts the moment you press play, rather than waiting for the next poll.

---

## Activity log

| Status | What it means |
|---|---|
| **Webhook** | Tautulli sent a play event — Episode Guard woke up immediately |
| **Confirmed** | Episode was already on disk, nothing to do |
| **Grabbed** | Triggered a search in Sonarr for a missing episode |
| **Monitored** | An upcoming episode wasn't monitored — fixed it so Sonarr grabs it when it airs |
| **Season Monitored** | Next season isn't out yet — marked it monitored so Sonarr picks it up on release |
| **Error** | Something went wrong — check the details column |

---

## Quick start

```bash
cp .env.example .env
# fill in your API keys
docker compose up -d
```

Open `http://localhost:8988` for the dashboard.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TAUTULLI_URL` | yes | e.g. `http://tautulli:8181` |
| `TAUTULLI_API_KEY` | yes | Tautulli → Settings → Web Interface |
| `SONARR_URL` | yes | e.g. `http://sonarr:8989` |
| `SONARR_API_KEY` | yes | Sonarr → Settings → General |
| `WEB_USERNAME` | yes | Dashboard login username |
| `WEB_PASSWORD` | yes | Dashboard login password |
| `PORT` | no | Override the default port (8988) |
| `DATA_DIR` | no | Path inside container for SQLite DB. Default: `/data` |

---

## In-app settings

These live in the dashboard Settings tab, stored in SQLite rather than env vars:

| Setting | Default | What it does |
|---|---|---|
| `poll_interval_seconds` | 300 | How often to poll Tautulli. Jumps to 600 when webhook mode is on |
| `lookahead_episodes` | 3 | Episodes ahead to check and grab |
| `season_end_buffer` | 3 | Episodes from the finale before checking the next season |
| `log_retention_days` | 30 | How long to keep activity log entries |
| `apprise_url` | — | Apprise endpoint for notifications |
| `apprise_events` | `episode_grabbed` | Comma-separated events to notify on: `episode_grabbed`, `episode_monitored`, `season_monitored`, `error` |
| `webhook_enabled` | off | React on play via webhook — polling drops to a fallback |

---

## Tautulli webhook setup

1. Tautulli → Settings → Notification Agents → add a **Webhook**
2. Set the Webhook URL to `http://your-episodeguard-host:8988/api/webhook`
3. No authentication needed — the endpoint is intentionally unauthenticated
4. Under **Triggers**, enable **Playback Start**
5. Under **Data**, paste this JSON body:

```json
{
  "media_type": "{media_type}",
  "grandparent_title": "{show_name}",
  "parent_media_index": "{season_num}",
  "media_index": "{episode_num}",
  "grandparent_guids": ["tvdb://{thetvdb_id}"]
}
```

Season and episode numbers must be quoted strings — Tautulli's JSON validator rejects bare integers in templates. The handler parses them with `parseInt` so this is fine.

When a webhook is received the dashboard status bar shows **Webhook: X ago**. If it shows **never received** after playing something, Tautulli isn't reaching the endpoint — check the URL and that Episode Guard is accessible from the Tautulli host.

---

## Building

```bash
docker build -t episodeguard .
```

No npm install needed — uses Node's built-in `fetch`.
