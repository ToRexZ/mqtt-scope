// A local stand-in for GitHub's latest-release endpoint, for the
// MQTTSCOPE_UPDATE_URL override: serves `release` (GitHub release JSON) as
// /release.json on 127.0.0.1, or 503 while it is null. Counts every request.

import { createServer } from 'node:http';

export async function startReleaseServer(release) {
  let current = release;
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    if (req.url !== '/release.json') return res.writeHead(404).end();
    if (current === null) return res.writeHead(503).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(current));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed = null;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    setRelease(next) {
      current = next;
    },
    requests: () => count,
    // Idempotent; drops open keep-alive connections so the port really refuses.
    close() {
      closed ||= new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
