// Secrets and connection details — env vars only, never stored in DB
export const env = {
  tautulliUrl:  process.env.TAUTULLI_URL?.replace(/\/$/, ''),
  tautulliApiKey: process.env.TAUTULLI_API_KEY,
  sonarrUrl:    process.env.SONARR_URL?.replace(/\/$/, ''),
  sonarrApiKey: process.env.SONARR_API_KEY,
  secretKey:    process.env.SECRET_KEY,
  appUrl:       (process.env.APP_URL ?? 'http://localhost:8988').replace(/\/$/, ''),
  dataDir:      process.env.DATA_DIR ?? '/data',
  port:         parseInt(process.env.PORT ?? '8988', 10),
};

export function validateConfig() {
  const required = ['tautulliUrl', 'tautulliApiKey', 'sonarrUrl', 'sonarrApiKey', 'secretKey'];
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required env var for: ${key}`);
  }
}
