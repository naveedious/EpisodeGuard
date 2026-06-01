# Episode Guard

> A Digital ferret that makes sure your next episode is ready before you want to watch it.

Episode Guard watches Tautulli for what you're playing and tells Sonarr to grab upcoming episodes before you get there. No more finishing an episode and finding the next one isn't downloaded.

## How it works

Every time Tautulli sees you watching a TV episode, Episode Guard:

1. Looks ahead a configurable number of episodes and grabs anything missing. Before triggering a search, it checks the Sonarr queue — if an episode is already downloading, queued, or pending, the search is skipped to avoid duplicate grabs. If an episode is in a failed or warning state, it re-searches normally.
2. Near the end of a season, checks what's next:
   - If the next season hasn't aired or is still airing, marks the whole season monitored so Sonarr picks up episodes as they release, and searches for any aired-but-missing episodes
   - If the next season has fully aired, searches all missing episodes by ID directly (bypasses monitored status)
3. Sends a notification via Apprise for anything it acts on

You can also point Tautulli webhooks at Episode Guard so it reacts the moment you press play, rather than waiting for the next poll.

## Activity log

| Event | What it means |
|---|---|
| **Webhook** | Tautulli sent a play event, Episode Guard woke up immediately |
| **Confirmed** | Currently playing, on disk by definition |
| **Grabbed** | Search triggered in Sonarr for a missing episode |
| **On Disk** | Upcoming episode already on disk, or not aired yet. One row per episode |
| **In Queue** | Episode is already downloading or queued in Sonarr, search skipped |
| **Monitored** | Upcoming episode wasn't monitored, fixed so Sonarr grabs it when it airs |
| **Season Monitored** | Near season end, next season marked monitored |
| **Error** | Something went wrong, check the details column |

Each upcoming episode gets its own row so you can see exactly what was checked and why. The details column shows a plain-English summary. For unaired episodes it includes the expected air date.

## Quick start

Set your environment variables in the `environment` section of your `docker-compose.yml`. At least one media source (Tautulli or Jellyfin) must be configured — both can run simultaneously:

```yaml
services:
  episodeguard:
    image: episodeguard
    environment:
      # Tautulli (Plex) — optional if Jellyfin is configured
      TAUTULLI_URL: http://tautulli:8181
      TAUTULLI_API_KEY: your_tautulli_api_key
      # Jellyfin — optional if Tautulli is configured
      JELLYFIN_URL: http://jellyfin:8096
      JELLYFIN_API_KEY: your_jellyfin_api_key
      SONARR_URL: http://sonarr:8989
      SONARR_API_KEY: your_sonarr_api_key
      SECRET_KEY: your_random_secret
      APP_URL: http://episodeguard.yourdomain.com
    ports:
      - "8988:8988"
    volumes:
      - ./data:/data
```

Then start it:

```bash
docker compose up -d
```

### Running rootless

The container runs as the built-in `node` user (uid 1000). If you bind-mount the data directory, the host folder needs to be writable by uid 1000.

First check what uid your host user is:

```bash
id your-username
```

If it is uid 1000, just make sure the data folder is writable:

```bash
chmod -R u+w ./data
```

If it is a different uid, transfer ownership to 1000 directly:

```bash
chown -R 1000:1000 ./data
```

If the data directory does not exist yet, create it with the right ownership before starting the container:

```bash
mkdir -p ./data && chown 1000:1000 ./data
```

Open `http://localhost:8988` and you'll be redirected to the login page.

On first run, a local `admin` account is created and the temporary password is printed to the container logs:

```bash
docker logs episodeguard 2>&1 | grep -A5 "FIRST RUN"
```

Change the password in **Settings > Change Local Password** after logging in.

## Authentication

Episode Guard supports OIDC (recommended) with a local account fallback.

### OIDC (e.g. Authentik)

1. Create an OAuth2/OIDC application in your provider:
   - **Redirect URI:** `http://your-episodeguard-host:8988/auth/callback/<provider-id>` (the ID is shown after you save the provider in Settings)
   - **Scopes:** `openid email profile`
2. In Episode Guard Settings > **OIDC Providers**, click **Add Provider** and fill in the display name, Issuer URL, Client ID, and Client Secret
3. In **Allowed OIDC Users**, add each user by their **Subject ID** from your provider's admin panel
4. Users can now log in via the OIDC button on the login page

The local admin account stays available as a fallback if OIDC is unreachable.

### Local fallback

If no OIDC provider is configured, or the provider is unavailable, the login page shows the local login form directly. Use the `admin` account created on first run.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TAUTULLI_URL` | one of Tautulli/Jellyfin | e.g. `http://tautulli:8181` |
| `TAUTULLI_API_KEY` | one of Tautulli/Jellyfin | Tautulli > Settings > Web Interface |
| `JELLYFIN_URL` | one of Tautulli/Jellyfin | e.g. `http://jellyfin:8096` |
| `JELLYFIN_API_KEY` | one of Tautulli/Jellyfin | Jellyfin > Dashboard > API Keys |
| `SONARR_URL` | yes | e.g. `http://sonarr:8989` |
| `SONARR_API_KEY` | yes | Sonarr > Settings > General |
| `SECRET_KEY` | yes | Random secret for session signing and OIDC secret encryption. Generate with `openssl rand -base64 32` |
| `APP_URL` | no | Full URL Episode Guard is reachable at, used for OIDC redirect URIs. Default: `http://localhost:8988` |
| `PORT` | no | Override the default port (8988) |
| `DATA_DIR` | no | Path inside container for SQLite DB. Default: `/data` |

## In-app settings

These live in the Settings tab, stored in SQLite:

| Setting | Default | What it does |
|---|---|---|
| `poll_interval_seconds` | 300 | How often to poll Tautulli |
| `lookahead_episodes` | 3 | Episodes ahead to check and grab |
| `season_end_buffer` | 3 | Episodes from the finale before checking the next season |
| `log_retention_days` | 30 | How long to keep activity log entries |
| `apprise_url` | (none) | Apprise endpoint for notifications |
| `apprise_events` | `episode_grabbed` | Comma-separated events to notify on |
| `webhook_enabled` | off | React on play via webhook, polling drops to a fallback |
| `webhook_secret` | (none) | Optional secret to validate incoming webhook requests |
| `session_max_age_hours` | 24 | How long before users are signed out |

## Webhook setup

Episode Guard accepts webhooks from both Tautulli and Jellyfin at the same endpoint. The source is detected automatically from the payload shape — no configuration needed.

## Tautulli webhook setup

1. Tautulli > Settings > Notification Agents > add a **Webhook**
2. Set the Webhook URL to `http://your-episodeguard-host:8988/api/webhook`
3. Under **Triggers**, enable **Playback Start**
4. Under **Data**, set Method to **POST** and paste this JSON body:

```json
{
  "media_type": "{media_type}",
  "grandparent_title": "{show_name}",
  "parent_media_index": "{season_num}",
  "media_index": "{episode_num}",
  "grandparent_guids": ["tvdb://{thetvdb_id}"]
}
```

Season and episode numbers need to be quoted strings. Tautulli's JSON validator rejects bare integers in templates, but the handler parses them with `parseInt` so this works fine.

When webhook mode is on, the dashboard status bar shows **Webhook active**. To confirm webhooks are landing, check the activity log. A successful webhook shows as a **Webhook** row followed immediately by the processing results. If you play something and see no Webhook row, Tautulli isn't reaching the endpoint. Check the URL and that Episode Guard is accessible from the Tautulli host.

Episodes triggered by webhook are skipped by polling for 4 hours to avoid double-processing. Polling still runs as a fallback for any play events Tautulli fails to deliver.

### Optional webhook secret

To block unauthorised requests to the webhook endpoint:

1. Set a **Webhook Secret** in Settings > Webhook Security
2. In Tautulli, add a custom HTTP header to the webhook agent:

```
Header name:  X-Webhook-Token
Header value: <your secret>
```

Tautulli path: Notification Agents > your webhook > **Headers** tab.

If a secret is configured and the header is missing or wrong, Episode Guard returns `401` and ignores the request.

## Jellyfin webhook setup

1. In Jellyfin, go to Dashboard > Plugins > Catalog and install the **Webhook** plugin, then restart Jellyfin
2. Go to Dashboard > Plugins > Webhook and add a new destination:
   - **URL:** `http://your-episodeguard-host:8988/api/webhook`
   - **Notification Type:** Playback Start
   - **Template:** Default (no customisation needed)
3. If you have a webhook secret configured, add it under **Headers**: `X-Webhook-Token: <your secret>`

Episode Guard detects Jellyfin payloads automatically. For reliable show matching, ensure your Jellyfin series have TVDB metadata populated (Dashboard > Libraries > refresh metadata). If TVDB is missing, Episode Guard falls back to title matching against Sonarr. If a title matches multiple series in Sonarr, the episode is skipped with a warning in the logs.

## Dual-source operation

When both Tautulli and Jellyfin are configured, Episode Guard polls both simultaneously and merges the results. If the same episode is detected on both sources at once (e.g. two users watching on different servers), it is processed once — the duplicate is dropped before any Sonarr calls are made.

## Version display

The app header shows the current version (e.g. `v2.0.0`) next to the Episode Guard logo. It reads from `/api/version`, which pulls the version field from `package.json` at startup.

## Building

```bash
docker build -t episodeguard .
```
