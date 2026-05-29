import { env } from './config.js';

export function basicAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return challenge(res);

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return challenge(res);

  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  if (user === env.webUsername && pass === env.webPassword) {
    return next();
  }
  return challenge(res);
}

function challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="episode-guard"');
  res.status(401).send('Unauthorized');
}
