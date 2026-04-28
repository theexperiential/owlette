import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { parse } from 'node:url';

import next from 'next';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) {
    args.set(process.argv[i].slice(2), process.argv[i + 1]);
    i += 1;
  }
}

const port = Number(args.get('port') || process.env.PORT || 3100);
const hostname = args.get('hostname') || process.env.HOSTNAME || '127.0.0.1';
const staticRoot = path.resolve(process.cwd(), '.next', 'static');
const staticPrefix = '/_next/static/';

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function serveNextStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(new URL(req.url || '/', `http://${hostname}:${port}`).pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return true;
  }

  if (!pathname.startsWith(staticPrefix)) {
    return false;
  }

  const relativePath = pathname.slice(staticPrefix.length);
  const filePath = path.resolve(staticRoot, relativePath);

  if (!isPathInside(filePath, staticRoot)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }

  if (!stats.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return true;
  }

  res.writeHead(200, {
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': stats.size,
    'content-type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'last-modified': stats.mtime.toUTCString(),
  });

  createReadStream(filePath).pipe(res);
  return true;
}

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

createServer(async (req, res) => {
  try {
    if (await serveNextStatic(req, res)) {
      return;
    }

    await handle(req, res, parse(req.url || '/', true));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('Internal server error');
  }
}).listen(port, hostname, () => {
  console.log(`E2E Next server ready on http://${hostname}:${port}`);
});
