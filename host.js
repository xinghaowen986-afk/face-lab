import { initAnalyzer, analyzePhoto } from './analysis.js';

const $ = (id) => document.getElementById(id);
const ui = {
  start: $('startButton'),
  stop: $('stopButton'),
  badge: $('statusBadge'),
  title: $('heroTitle'),
  description: $('heroDescription'),
  hint: $('connectionHint'),
  completed: $('completedCount'),
  duration: $('lastDuration'),
  runtime: $('runtimeValue'),
  activity: $('activity'),
};

const API_BASE = '';
let token = '';
let running = false;
let stopping = false;
let pollController = null;
let retryTimer = null;
let retryWake = null;
let retryAttempt = 0;
let completed = 0;
let generation = 0;

const sleep = (ms) => new Promise((resolve) => {
  retryWake = resolve;
  retryTimer = setTimeout(() => { retryTimer = null; retryWake = null; resolve(); }, ms);
});
const delayForAttempt = (attempt) => Math.min(10000, 600 * (2 ** Math.min(attempt, 4)));
const authHeaders = () => token ? { 'X-Host-Session': token } : {};

function setBadge(kind, label) {
  ui.badge.className = `badge ${kind}`;
  ui.badge.textContent = label;
}

function showActivity(message = '', error = false) {
  ui.activity.textContent = message;
  ui.activity.classList.toggle('error', error);
}

function setUiState(state, message = '') {
  if (state === 'online') {
    setBadge('online', '在线等待任务');
    ui.title.textContent = '主机服务正在工作';
    ui.description.textContent = '访客现在可以选择主机电脑分析。保持此页面打开，完成任务后照片会立即释放。';
    ui.runtime.textContent = '在线';
    ui.start.disabled = true;
    ui.stop.disabled = false;
    ui.hint.innerHTML = '<strong>已连接。</strong> 主机只在内存中处理当前任务，不会保存照片。';
  } else if (state === 'starting') {
    setBadge('starting', '正在启动');
    ui.title.textContent = '正在准备主机服务';
    ui.description.textContent = message || '正在加载本地人脸模型，请稍候。';
    ui.runtime.textContent = '启动中';
    ui.start.disabled = true;
    ui.stop.disabled = false;
    ui.hint.innerHTML = '<strong>请稍候。</strong> 模型就绪后才会接受访客任务。';
  } else if (state === 'error') {
    setBadge('error', '连接异常');
    ui.title.textContent = '主机服务需要重试';
    ui.description.textContent = message || '服务暂时不可用，正在等待下一次连接。';
    ui.runtime.textContent = '异常';
    ui.start.disabled = running;
    ui.stop.disabled = !running;
    ui.hint.innerHTML = '<strong>正在恢复连接。</strong> 你也可以停止服务后重新启动。';
  } else {
    setBadge('stopped', '未启动');
    ui.title.textContent = '主机服务尚未启动';
    ui.description.textContent = '点击“启动主机服务”后，浏览器会加载人脸模型并等待访客任务。你可以随时停止服务。';
    ui.runtime.textContent = '离线';
    ui.start.disabled = false;
    ui.stop.disabled = true;
    ui.hint.innerHTML = '<strong>等待启动。</strong> 启动后会在本机内存中保留临时配对令牌，不会写入浏览器存储。';
  }
}

async function readError(response, fallback) {
  let detail = '';
  try {
    const payload = await response.json();
    detail = payload?.error?.message || payload?.message || '';
  } catch { /* response may be plain text */ }
  return detail || `${fallback}（HTTP ${response.status}）`;
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
  try {
    return await fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      ...options,
      signal: controller.signal,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
  } catch (error) {
    if (timedOut) throw new Error('本机服务响应超时，请确认主机程序仍在运行。');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

async function getSession() {
  const response = await request('/internal/session');
  if (!response.ok) throw new Error(await readError(response, '无法建立主机配对'));
  let payload;
  try { payload = await response.json(); } catch { throw new Error('主机配对响应格式不完整。'); }
  if (!payload || typeof payload.token !== 'string' || !payload.token) throw new Error('主机没有返回有效的临时配对令牌。');
  return payload.token;
}

async function setReady(ready, keepalive = false) {
  if (!token) return;
  const response = await request('/internal/ready', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ready: Boolean(ready) }),
    keepalive,
  });
  if (!keepalive && !response.ok) throw new Error(await readError(response, ready ? '主机服务无法上线' : '主机服务无法停止'));
}

function base64ToBlob(data, mime = 'image/png') {
  if (typeof data !== 'string' || !data) throw new Error('任务照片数据为空。');
  const clean = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
  let binary;
  try { binary = atob(clean); } catch { throw new Error('任务照片编码无效。'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'image/png' });
}

async function decodeJob(job) {
  const blob = base64ToBlob(job.data, job.mime);
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = 'async';
  image.src = objectUrl;
  try {
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('任务照片无法解码。');
    return { image, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function postResult(id, result, error) {
  const payload = error ? { id, error: { code: error.code || 'HOST_ANALYSIS_FAILED', message: error.message || '主机分析失败。' } } : { id, result };
  const response = await request('/internal/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readError(response, '分析结果发送失败'));
}

async function processJob(job) {
  const started = performance.now();
  let decoded = null;
  let analysisError = null;
  let value = null;
  try {
    decoded = await decodeJob(job);
    value = await analyzePhoto(decoded.image);
  } catch (error) {
    analysisError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (decoded) {
      URL.revokeObjectURL(decoded.objectUrl);
      decoded.image.src = '';
    }
  }
  const elapsed = Math.max(0, Math.round(performance.now() - started));
  await postResult(job.id, value, analysisError);
  completed += 1;
  ui.completed.textContent = String(completed);
  ui.duration.innerHTML = `${elapsed}<small> ms</small>`;
  showActivity(analysisError ? `任务 ${job.id} 已返回错误：${analysisError.message}` : `任务 ${job.id} 已完成，耗时 ${elapsed} ms。`);
}

async function pollJobs(run) {
  while (running && !stopping && run === generation) {
    pollController = new AbortController();
    try {
      if (retryAttempt > 0) {
        const refreshedToken = await getSession();
        if (!running || stopping || run !== generation) break;
        token = refreshedToken;
        await setReady(true);
      }
      const response = await request('/internal/job', { signal: pollController.signal });
      pollController = null;
      if (!running || stopping || run !== generation) break;
      if (response.status === 204) { retryAttempt = 0; setUiState('online'); continue; }
      if (response.status === 401 || response.status === 403) throw new Error('主机配对已失效，请停止后重新启动。');
      if (!response.ok) throw new Error(await readError(response, '获取访客任务失败'));
      let job;
      try { job = await response.json(); } catch { throw new Error('主机任务响应格式无效。'); }
      if (!job || !job.id || typeof job.data !== 'string') throw new Error('主机任务缺少照片数据。');
      retryAttempt = 0;
      setUiState('online');
      setBadge('starting', '正在处理任务');
      ui.runtime.textContent = '处理中';
      showActivity(`正在处理任务 ${job.id}…`);
      await processJob(job);
      if (running && !stopping && run === generation) setUiState('online');
    } catch (error) {
      pollController = null;
      if (stopping || !running || run !== generation || error?.name === 'AbortError') break;
      const message = error instanceof Error ? error.message : String(error);
      retryAttempt += 1;
      setUiState('error', message);
      showActivity(`${message} 将在 ${Math.round(delayForAttempt(retryAttempt) / 100) / 10} 秒后重试。`, true);
      await sleep(delayForAttempt(retryAttempt));
    }
  }
}

async function start() {
  if (running) return;
  const run = ++generation;
  stopping = false;
  running = true;
  retryAttempt = 0;
  setUiState('starting');
  showActivity('正在建立临时配对…');
  try {
    const sessionToken = await getSession();
    if (!running || stopping || run !== generation) return;
    token = sessionToken;
    await initAnalyzer((message) => {
      if (running && !stopping && run === generation) { ui.description.textContent = message; showActivity(message); }
    });
    if (!running || stopping || run !== generation) return;
    await setReady(true);
    if (!running || stopping || run !== generation) return;
    setUiState('online');
    showActivity('主机已上线，正在等待访客任务。');
    void pollJobs(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stopping || run !== generation) return;
    running = false;
    token = '';
    setUiState('error', message);
    showActivity(message, true);
  }
}

async function stop() {
  if (!running && !token) return;
  stopping = true;
  running = false;
  generation += 1;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (retryWake) { const wake = retryWake; retryWake = null; wake(); }
  if (pollController) { pollController.abort(); pollController = null; }
  try { await setReady(false); } catch (error) { showActivity(error instanceof Error ? error.message : String(error), true); }
  token = '';
  setUiState('stopped');
  if (!ui.activity.classList.contains('error')) showActivity('主机服务已停止，照片与配对令牌已从当前页面释放。');
  stopping = false;
}

ui.start.addEventListener('click', () => { void start(); });
ui.stop.addEventListener('click', () => { void stop(); });
window.addEventListener('beforeunload', () => {
  if (!token) return;
  try {
    fetch('/internal/ready', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ready: false }), keepalive: true });
  } catch { /* best effort during page teardown */ }
});

setUiState('stopped');

