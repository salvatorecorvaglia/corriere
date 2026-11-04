import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const bundle = readFileSync(new URL('../../esm/index.js', import.meta.url));
const counts = new Map();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (body) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><title>Corriere browser tests</title><script type="module">import corriere from "/corriere.js"; window.corriere = corriere;</script>',
    );
  } else if (url.pathname === '/corriere.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(bundle);
  } else if (url.pathname === '/echo') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    json({ headers: request.headers, body: Buffer.concat(chunks).toString() });
  } else if (url.pathname === '/counted') {
    const key = url.searchParams.get('key');
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    setTimeout(() => json({ count, nested: { value: 1 } }), 15);
  } else if (url.pathname === '/redirect') {
    response.writeHead(302, { location: '/json' });
    response.end();
  } else if (url.pathname === '/slow') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  } else if (url.pathname === '/stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"value":1}\n\n');
    const timer = setTimeout(() => response.end('data: {"value":2}\n\n'), 10);
    response.once('close', () => clearTimeout(timer));
  } else if (url.pathname === '/api/items') {
    const page = Number(url.searchParams.get('page') || 1);
    json({ items: [page], next: page === 1 ? '?page=2' : null });
  } else if (url.pathname === '/failure') {
    response.statusCode = 400;
    json({ message: 'bad request' });
  } else if (url.pathname === '/json') {
    json({ ok: true });
  } else {
    response.statusCode = 404;
    response.end();
  }
});
server.listen(Number(process.env.CORRIERE_BROWSER_PORT || 4179), '127.0.0.1');
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
});
