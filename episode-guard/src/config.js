// Secrets and connection details — env vars only, never stored in DB
export const env = {
  tautulliUrl:  process.env.TAUTULLI_URL?.replace(/\/$/, ''),
  tautulliApiKey: process.env.TAUTULLI_API_KEY,
  sonarrUrl:    process.env.SONARR_URL?.replace(/\/$/, ''),
  sonarrApiKey: process.env.SONARR_API_KEY,
  webUsername:  process.env.WEB_USERNAME,
  webPassword:  process.env.WEB_PASSWORD,
  dataDir:      process.env.DATA_DIR ?? '/data',
  port:         parseInt(process.env.PORT ?? '3000', 10),
};

export function validateConfig() {
  const required = ['tautulliUrl', 'tautulliApiKey', 'sonarrUrl', 'sonarrApiKey', 'webUsername', 'webPassword'];
  for (const key of required) {
    if (!env[key]) throw new Error(`Missing required env var for: ${key}`);
  }
}
