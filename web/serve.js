// @ts-check
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Served from the repo root rather than from web/, because the page imports
// the interpreter straight out of ../src. There is no build step, so the
// browser resolves those paths itself and they have to exist under the root.
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8080);

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pip': 'text/plain; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  // Redirect rather than serve the page at `/`: the page's own `./ui.js` and
  // `./style.css` resolve against whatever path the browser thinks it is on,
  // and from `/` that is the repo root, where neither file lives.
  if (url.pathname === '/') {
    response.writeHead(302, { location: '/web/' }).end();
    return;
  }
  const requested = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;

  // normalize collapses any ../ before the join, so a crafted path cannot
  // climb out of the repo.
  const path = join(ROOT, normalize(decodeURIComponent(requested)));
  if (!path.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`not found: ${requested}`);
  }
});

server.listen(PORT, () => {
  console.log(`Pip debugger on http://localhost:${PORT}/`);
});
