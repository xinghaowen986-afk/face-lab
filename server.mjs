import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = await realpath(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.task': 'application/octet-stream',
};
const insideRoot = (candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const reply = (res, status, message, head = false) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(head ? undefined : message);
};

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    reply(res, 405, 'Method not allowed');
    return;
  }
  const head = req.method === 'HEAD';
  try {
    const rawPath = (req.url || '/').split('?')[0];
    const pathname = decodeURIComponent(rawPath);
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      reply(res, 403, 'Forbidden', head);
      return;
    }
    const requested = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!insideRoot(requested)) {
      reply(res, 403, 'Forbidden', head);
      return;
    }
    const resolved = await realpath(requested);
    if (!insideRoot(resolved)) {
      reply(res, 403, 'Forbidden', head);
      return;
    }
    const file = await stat(resolved);
    if (!file.isFile()) {
      reply(res, 404, 'Not found', head);
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Content-Length': file.size,
    });
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(resolved);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    if (error instanceof URIError) reply(res, 400, 'Invalid path', head);
    else if (['ENOENT', 'ENOTDIR'].includes(error.code)) reply(res, 404, 'Not found', head);
    else reply(res, 500, 'Unable to read file', head);
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Open http://127.0.0.1:${port}/ or set PORT to another value.`
    : `Server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Face Lab: ${url}`);
  console.log('Local only. Press Ctrl+C to stop.');
  if (process.argv.includes('--no-open')) return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
  const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.log(`Open this address in your browser: ${url}`));
  browser.unref();
});
