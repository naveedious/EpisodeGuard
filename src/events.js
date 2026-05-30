/**
 * Simple SSE pub/sub. Any module can call emitLogEvent to push a log row
 * to all connected /api/logs/stream clients.
 */

const clients = new Set();

export function addSseClient(res) {
  clients.add(res);
}

export function removeSseClient(res) {
  clients.delete(res);
}

export function emitLogEvent(row) {
  if (!clients.size) return;
  const data = `data: ${JSON.stringify(row)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}
