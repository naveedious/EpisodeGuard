export const sonarrMockState = { queue: [], episode: null, episodeFile: null, calls: [] };

export function installSonarrMock() {
  sonarrMockState.calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url.toString());
    const path = u.pathname.replace(/^.*\/api\/v3/, '');
    const fullPath = path + u.search;
    sonarrMockState.calls.push({ method: opts.method || 'GET', path: fullPath, body: opts.body ? JSON.parse(opts.body) : null, query: u.search });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (opts.method === 'GET' && path === '/queue') return json({ page: 1, records: sonarrMockState.queue });
    if (opts.method === 'DELETE' && path.startsWith('/queue/')) return json({});
    if (opts.method === 'DELETE' && path.startsWith('/episodefile/')) return json({});
    if (opts.method === 'POST' && path === '/command') return json({ id: 1, status: 'queued' });
    if (opts.method === 'GET' && path === '/episode/42') return json(sonarrMockState.episode || { id: 42, hasFile: false, episodeFileId: null });
    if (opts.method === 'GET' && path === '/episode/44') return json(sonarrMockState.episode || { id: 44, hasFile: false, episodeFileId: null });
    if (opts.method === 'GET' && path.startsWith('/episodefile/')) {
      return sonarrMockState.episodeFile ? json(sonarrMockState.episodeFile) : json({}, 404);
    }
    return json({}, 404);
  };
  return () => { globalThis.fetch = realFetch; };
}
