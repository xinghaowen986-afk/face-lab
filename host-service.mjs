import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const ROOT = await realpath(path.dirname(fileURLToPath(import.meta.url)));
const IMAGE_LIMIT = 6 * 1024 * 1024;
const RESULT_LIMIT = 512 * 1024;
const DEFAULT_ORIGINS = ['https://xinghaowen986-afk.github.io', 'http://127.0.0.1:4173'];
const STATIC_FILES = new Map([
  ['/', 'host.html'], ['/host.html', 'host.html'], ['/host.js', 'host.js'],
  ['/index.html', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css'],
  ['/config.js', 'config.js'], ['/analysis.js', 'analysis.js'],
  ['/assets/example.jpg', 'assets/example.jpg'],
  ['/vendor/face_landmarker.task', 'vendor/face_landmarker.task'],
  ['/vendor/vision_bundle.mjs', 'vendor/vision_bundle.mjs'],
  ['/vendor/wasm/vision_wasm_internal.js', 'vendor/wasm/vision_wasm_internal.js'],
  ['/vendor/wasm/vision_wasm_internal.wasm', 'vendor/wasm/vision_wasm_internal.wasm'],
  ['/vendor/wasm/vision_wasm_nosimd_internal.js', 'vendor/wasm/vision_wasm_nosimd_internal.js'],
  ['/vendor/wasm/vision_wasm_nosimd_internal.wasm', 'vendor/wasm/vision_wasm_nosimd_internal.wasm'],
]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };

function json(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  if (status === 204) { res.writeHead(204, { 'Cache-Control': 'no-store', ...headers }); res.end(); return; }
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const errorResponse = (res, status, code, message, headers = {}) => json(res, status, { error: { code, message } }, headers);
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function isLoopbackAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address).toLowerCase());
}
function normalizePath(url) {
  try {
    const value = decodeURIComponent(String(url || '/').split('?')[0]);
    return value.startsWith('/') && !value.includes('\0') && !value.includes('\\') && !value.split('/').includes('..') ? value : null;
  } catch { return null; }
}
function imageMimeFromMagic(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function parseOrigins(value) {
  const values = Array.isArray(value) ? value : value === undefined ? DEFAULT_ORIGINS : String(value).split(',');
  return new Set(values.map((item) => String(item).trim()).filter((item) => {
    try { const url = new URL(item); return url.origin === item && ['https:', 'http:'].includes(url.protocol); } catch { return false; }
  }));
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const wipe = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const finish = (error, body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onError);
      wipe();
      if (error) { req.resume(); reject(error); } else resolve(body);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { chunk.fill(0); finish(Object.assign(new Error('Body too large'), { code: 'TOO_LARGE' })); }
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, size));
    const onAbort = () => finish(Object.assign(new Error('Client disconnected'), { code: 'ABORTED' }));
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(Object.assign(new Error('Body timeout'), { code: 'BODY_TIMEOUT' })), 10_000);
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onError);
  });
}
function validResult(value) {
  return value && typeof value === 'object' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
    && Array.isArray(value.dimensions) && value.dimensions.length === 4
    && value.dimensions.every((item) => item && Number.isFinite(item.score) && typeof item.label === 'string')
    && typeof value.summary === 'string'
    && Array.isArray(value.strengths) && value.strengths.every((item) => typeof item === 'string')
    && Array.isArray(value.suggestions) && value.suggestions.every((item) => typeof item === 'string')
    && Array.isArray(value.landmarks) && value.landmarks.length >= 455 && value.landmarks.length <= 1000
    && value.landmarks.every((item) => item && Number.isFinite(item.x) && Number.isFinite(item.y));
}

export { IMAGE_LIMIT, STATIC_FILES, imageMimeFromMagic, isLoopbackAddress, parseOrigins, validResult };

export async function createHostService(options = {}) {
  const configuredInternalPort = Number(options.internalPort ?? options.ports?.internal ?? process.env.FACE_LAB_INTERNAL_PORT ?? 4174);
  const configuredPublicPort = Number(options.publicPort ?? options.ports?.public ?? process.env.FACE_LAB_PUBLIC_PORT ?? 4175);
  for (const port of [configuredInternalPort, configuredPublicPort]) if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid host service port.');
  const origins = parseOrigins(options.allowedOrigins ?? process.env.FACE_LAB_ALLOWED_ORIGINS);
  const accessCode = String(options.accessCode ?? process.env.FACE_LAB_ACCESS_CODE ?? '');
  const sessionToken = randomBytes(32).toString('hex');
  const jobTimeoutMs = options.jobTimeoutMs ?? 45_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 15_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
  const queue = [];
  const admitted = new Set();
  const requestTimes = [];
  let active = null;
  let poll = null;
  let ready = false;
  let lastSeen = 0;
  let closing = false;
  let internalServer;
  let publicServer;
  const portOf = (server) => server?.address()?.port || 0;
  const internalHosts = () => [`127.0.0.1:${portOf(internalServer)}`, `localhost:${portOf(internalServer)}`];
  const internalRequestAllowed = (req) => isLoopbackAddress(req.socket.remoteAddress)
    && internalHosts().includes(String(req.headers.host || '').toLowerCase())
    && (!req.headers.origin || internalHosts().some((host) => req.headers.origin === `http://${host}`))
    && req.headers['sec-fetch-site'] !== 'cross-site';
  const online = () => ready && Date.now() - lastSeen <= heartbeatTimeoutMs && !closing;
  const touch = () => { lastSeen = Date.now(); };
  const clearBody = (job) => { if (job.body) job.body.fill(0); job.body = null; };
  const clearJob = (job) => { clearTimeout(job.timer); clearBody(job); admitted.delete(job); };
  function finish(job, status, payload) {
    if (job.settled) return;
    job.settled = true;
    clearBody(job);
    json(job.res, status, payload, job.cors);
  }
  function dropPoll(status = 204, payload = null) {
    if (!poll) return;
    const current = poll; poll = null;
    clearTimeout(current.timer);
    current.res.off('close', current.onClose);
    json(current.res, status, payload);
  }
  function dispatch() {
    if (!poll || active || !online() || queue.length === 0) return;
    const currentPoll = poll; poll = null;
    clearTimeout(currentPoll.timer); currentPoll.res.off('close', currentPoll.onClose);
    const job = queue.shift();
    if (job.settled || job.res.destroyed) { clearJob(job); json(currentPoll.res, 204, null); return; }
    active = job;
    touch();
    const data = job.body.toString('base64');
    // Keep the body available until the browser acknowledges the result, then clear it.
    json(currentPoll.res, 200, { id: job.id, mime: job.mime, data });
  }
  function offline(message = '主机浏览器已离线。') {
    ready = false;
    dropPoll(503, { error: { code: 'WORKER_OFFLINE', message } });
    for (const job of [...admitted]) { finish(job, 503, { error: { code: 'WORKER_OFFLINE', message } }); clearJob(job); }
    queue.length = 0;
    active = null;
  }
  function housekeeping() {
    if (ready && Date.now() - lastSeen > heartbeatTimeoutMs) offline();
  }
  function corsFor(req, allowMissing = false) {
    const origin = req.headers.origin;
    if (!origin) return allowMissing ? {} : null;
    return origins.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;
  }
  async function handleInternal(req, res, pathname) {
    if (!internalRequestAllowed(req)) { errorResponse(res, 403, 'FORBIDDEN', 'Forbidden'); return; }
    if (pathname === '/internal/session' && req.method === 'GET') { json(res, 200, { token: sessionToken }); return; }
    if (!safeEqual(req.headers['x-host-session'] || '', sessionToken)) { errorResponse(res, 401, 'UNAUTHORIZED', 'Invalid host session.'); req.resume(); return; }
    touch();
    if (pathname === '/internal/job' && req.method === 'GET') {
      if (!online()) { errorResponse(res, 409, 'NOT_READY', 'Host model is not ready.'); return; }
      if (poll || active) { errorResponse(res, 409, 'BUSY', 'A host request is already active.'); return; }
      const pending = { res, timer: null, onClose: null };
      pending.onClose = () => { if (poll === pending) { clearTimeout(pending.timer); poll = null; } };
      pending.timer = setTimeout(() => { if (poll === pending) { touch(); dropPoll(); } }, pollTimeoutMs);
      res.once('close', pending.onClose);
      poll = pending;
      dispatch();
      return;
    }
    if ((pathname !== '/internal/ready' && pathname !== '/internal/result') || req.method !== 'POST') { errorResponse(res, 404, 'NOT_FOUND', 'Not found'); return; }
    if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') { errorResponse(res, 415, 'BAD_TYPE', 'JSON required.'); req.resume(); return; }
    let bytes;
    try {
      bytes = await readBody(req, pathname === '/internal/result' ? RESULT_LIMIT : 1024);
      const value = JSON.parse(bytes.toString('utf8'));
      if (pathname === '/internal/ready') {
        if (typeof value.ready !== 'boolean') { errorResponse(res, 400, 'BAD_REQUEST', 'ready must be boolean.'); return; }
        if (value.ready) { ready = true; touch(); } else offline('主机浏览器已停止服务。');
        json(res, 200, { ok: true, online: online() });
        dispatch();
        return;
      }
      const job = active;
      if (!job || value.id !== job.id) { errorResponse(res, 404, 'UNKNOWN_JOB', 'Job is no longer active.'); return; }
      active = null;
      clearBody(job);
      if (value.error && typeof value.error === 'object') {
        const code = String(value.error.code || 'ANALYSIS_FAILED').slice(0, 80);
        const message = String(value.error.message || '主机分析失败。').slice(0, 500);
        finish(job, ['NO_FACE', 'MULTIPLE_FACES', 'INVALID_LANDMARKS', 'IMAGE_TOO_SMALL', 'IMAGE_NOT_READY'].includes(code) ? 422 : 500, { error: { code, message } });
      } else if (validResult(value.result)) finish(job, 200, value.result);
      else finish(job, 502, { error: { code: 'BAD_RESULT', message: '主机返回的数据格式不完整。' } });
      clearJob(job);
      json(res, 200, { ok: true });
      dispatch();
    } catch (error) { errorResponse(res, error.code === 'TOO_LARGE' ? 413 : 400, 'BAD_REQUEST', 'Invalid host request.'); }
    finally { bytes?.fill(0); }
  }
  async function handleStatic(req, res, pathname) {
    if (!internalRequestAllowed(req)) { errorResponse(res, 403, 'FORBIDDEN', 'Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { errorResponse(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { Allow: 'GET, HEAD' }); return; }
    const relative = STATIC_FILES.get(pathname);
    if (!relative) { errorResponse(res, 404, 'NOT_FOUND', 'Not found'); return; }
    try {
      const resolved = await realpath(path.join(ROOT, relative));
      const between = path.relative(ROOT, resolved);
      if (between.startsWith(`..${path.sep}`) || between === '..' || path.isAbsolute(between)) { errorResponse(res, 403, 'FORBIDDEN', 'Forbidden'); return; }
      const info = await stat(resolved);
      if (!info.isFile()) { errorResponse(res, 404, 'NOT_FOUND', 'Not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(resolved)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') res.end(); else createReadStream(resolved).on('error', () => res.destroy()).pipe(res);
    } catch (error) { errorResponse(res, error.code === 'ENOENT' ? 404 : 500, 'NOT_FOUND', 'Unable to read file'); }
  }
  async function handlePublic(req, res) {
    const pathname = normalizePath(req.url);
    const cors = corsFor(req, pathname === '/api/health');
    if (!['/api/health', '/api/analyze'].includes(pathname)) { errorResponse(res, 404, 'NOT_FOUND', 'Not found'); req.resume(); return; }
    if (cors === null) { errorResponse(res, 403, 'ORIGIN_DENIED', 'Origin not allowed.'); req.resume(); return; }
    if (req.method === 'OPTIONS') {
      json(res, 204, null, { ...cors, 'Access-Control-Allow-Methods': pathname === '/api/health' ? 'GET, OPTIONS' : 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return;
    }
    if (pathname === '/api/health') {
      if (req.method !== 'GET') { errorResponse(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { ...cors, Allow: 'GET, OPTIONS' }); return; }
      housekeeping();
      json(res, 200, { online: online(), busy: Boolean(active), queueLength: queue.length, accessCodeRequired: Boolean(accessCode) }, cors);
      return;
    }
    if (req.method !== 'POST') { errorResponse(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { ...cors, Allow: 'POST, OPTIONS' }); return; }
    if (accessCode && !safeEqual(req.headers.authorization || '', `Bearer ${accessCode}`)) { errorResponse(res, 401, 'UNAUTHORIZED', '请输入正确的主机访问码。', cors); req.resume(); return; }
    const now = Date.now();
    while (requestTimes.length && requestTimes[0] <= now - 60_000) requestTimes.shift();
    if (requestTimes.length >= 12) { errorResponse(res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试。', { ...cors, 'Retry-After': '60' }); req.resume(); return; }
    requestTimes.push(now);
    housekeeping();
    if (!online()) { errorResponse(res, 503, 'WORKER_OFFLINE', '主机电脑当前离线。', cors); req.resume(); return; }
    // Reserve capacity before reading bytes so concurrent uploads cannot bypass the queue bound.
    if (admitted.size >= (active ? 3 : 2)) { errorResponse(res, 429, 'QUEUE_FULL', '主机排队已满，请稍后再试。', cors); req.resume(); return; }
    const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) { errorResponse(res, 415, 'BAD_TYPE', '只支持 JPG、PNG 或 WebP 图片。', cors); req.resume(); return; }
    if (Number(req.headers['content-length'] || 0) > IMAGE_LIMIT) { errorResponse(res, 413, 'TOO_LARGE', '照片不能超过 6 MB。', cors); req.resume(); return; }
    const job = { id: randomBytes(16).toString('hex'), mime: type, body: null, res, cors, settled: false, timer: null };
    admitted.add(job);
    res.once('close', () => {
      if (job.settled) return;
      job.settled = true;
      clearBody(job);
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
      // A dispatched job keeps its single-worker slot until the worker returns or times out.
      if (active !== job) clearJob(job);
    });
    try {
      job.body = await readBody(req, IMAGE_LIMIT);
      if (job.settled || closing) { clearJob(job); return; }
      if (imageMimeFromMagic(job.body) !== type) { finish(job, 415, { error: { code: 'BAD_IMAGE', message: '照片格式与内容不匹配。' } }); clearJob(job); return; }
      if (!online()) { finish(job, 503, { error: { code: 'WORKER_OFFLINE', message: '主机电脑当前离线。' } }); clearJob(job); return; }
      job.timer = setTimeout(() => {
        const index = queue.indexOf(job); if (index !== -1) queue.splice(index, 1);
        if (active === job) active = null;
        finish(job, 504, { error: { code: 'JOB_TIMEOUT', message: '主机电脑分析超时，请重试或切回本机模式。' } });
        clearJob(job);
        dispatch();
      }, jobTimeoutMs);
      queue.push(job);
      dispatch();
    } catch (error) {
      finish(job, error.code === 'TOO_LARGE' ? 413 : error.code === 'BODY_TIMEOUT' ? 408 : 400, { error: { code: error.code || 'BAD_REQUEST', message: error.code === 'TOO_LARGE' ? '照片不能超过 6 MB。' : '无法读取照片。' } });
      clearJob(job);
    }
  }
  function wrap(handler) {
    return (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) errorResponse(res, 500, 'INTERNAL_ERROR', 'Internal error'); else res.destroy(); });
    };
  }
  internalServer = http.createServer(wrap((req, res) => {
    const pathname = normalizePath(req.url);
    return pathname?.startsWith('/internal/') ? handleInternal(req, res, pathname) : handleStatic(req, res, pathname);
  }));
  publicServer = http.createServer(wrap(handlePublic));
  for (const server of [internalServer, publicServer]) { server.requestTimeout = 12_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 50; }
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  try { await listen(internalServer, configuredInternalPort); await listen(publicServer, configuredPublicPort); }
  catch (error) { internalServer.close(); publicServer.close(); throw error; }
  const interval = setInterval(housekeeping, Math.min(5000, heartbeatTimeoutMs));
  interval.unref();
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    offline('主机服务已关闭。');
    for (const server of [internalServer, publicServer]) server.closeIdleConnections?.();
    await Promise.all([internalServer, publicServer].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); })));
  }
  return { internalServer, publicServer, internalPort: portOf(internalServer), publicPort: portOf(publicServer), accessCodeRequired: Boolean(accessCode), close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createHostService().then((service) => {
    console.log(`Face Lab host dashboard: http://127.0.0.1:${service.internalPort}/host.html`);
    const shutdown = () => { void service.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  }).catch((error) => { console.error(`Host service failed: ${error.message}`); process.exitCode = 1; });
}
