// Secrets and connection details — env vars only, never stored in DB
export const env = {
  tautulliUrl:    process.env.TAUTULLI_URL?.replace(/\/$/, ''),
  tautulliApiKey: process.env.TAUTULLI_API_KEY,
  jellyfinUrl:    process.env.JELLYFIN_URL?.replace(/\/$/, ''),
  jellyfinApiKey: process.env.JELLYFIN_API_KEY,
  sonarrUrl:      process.env.SONARR_URL?.replace(/\/$/, ''),
  sonarrApiKey:   process.env.SONARR_API_KEY,
  secretKey:      process.env.SECRET_KEY,
  appUrl:         (process.env.APP_URL ?? 'http://localhost:8988').replace(/\/$/, ''),
  dataDir:        process.env.DATA_DIR ?? '/data',
  port:           parseInt(process.env.PORT ?? '8988', 10),
};

export const sources = {
  tautulli: !!(env.tautulliUrl && env.tautulliApiKey),
  jellyfin:  !!(env.jellyfinUrl  && env.jellyfinApiKey),
};

export function validateConfig() {
  const required = ['sonarrUrl', 'sonarrApiKey', 'secretKey'];
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required env var for: ${key}`);
  }
  if (!sources.tautulli && !sources.jellyfin) {
    throw new Error('At least one media source must be configured: set TAUTULLI_URL+TAUTULLI_API_KEY and/or JELLYFIN_URL+JELLYFIN_API_KEY');
  }
}
