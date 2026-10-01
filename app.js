import { initAnalyzer, analyzePhoto } from './analysis.js';
import { requestHostAnalysis, resolveHostEndpoint, getHostHealth } from './remote.js';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['fileInput','uploadTrigger','dropZone','previewWrap','photoPreview','landmarkCanvas','photoLabel','photoHint','replaceButton','clearButton','analyzeButton','analyzeButtonText','exampleButton','status','scanLine','resultPanel','reportBadge','scoreRing','totalScore','ringValue','resultTitle','resultSummary','dimensions','emptyInsight','insights','strengths','suggestions','downloadButton','deviceModeButton','hostModeButton','hostModeStatus','computeHint'].map(id => [id, $(id)]));
let photo = null;
let photoBlob = null;
let result = null;
let objectURL = null;
let revision = 0;
let busy = false;
let photoName = '';
let computeMode = 'device';
let resultMode = 'device';
let hostState = null;
let hostCheckPending = false;
let analysisController = null;
const maxBytes = 12 * 1024 * 1024;
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const hostConfig = window.FACE_LAB_CONFIG || {};
const hostEndpoint = resolveHostEndpoint(String(hostConfig.hostEndpoint || '').trim(), location.href);
let hostAccessCode = '';
const hostAllowed = Boolean(hostEndpoint);

function setupComputeModes() {
  ui.hostModeButton.disabled = !hostAllowed;
  ui.hostModeStatus.textContent = hostAllowed ? '检查中' : '未配置';
  ui.hostModeButton.title = hostAllowed ? '使用已授权的主机电脑分析' : '需要先配置并启动主机服务';
  ui.computeHint.textContent = '默认使用你的设备，照片不上传。主机模式会把照片通过 HTTPS 发送到站点主人的电脑。';
  for (const button of [ui.deviceModeButton, ui.hostModeButton]) button.addEventListener('click', () => {
    if (button.disabled || computeMode === button.dataset.mode) return;
    revision++;
    analysisController?.abort();
    analysisController = null;
    computeMode = button.dataset.mode;
    resetResults();
    setBusy(false);
    ui.deviceModeButton.classList.toggle('active', computeMode === 'device');
    ui.hostModeButton.classList.toggle('active', computeMode === 'host');
    ui.deviceModeButton.setAttribute('aria-pressed', String(computeMode === 'device'));
    ui.hostModeButton.setAttribute('aria-pressed', String(computeMode === 'host'));
    $('hostConsentArea').hidden = computeMode !== 'host';
    $('processingLocation').textContent = computeMode === 'host' ? '照片将发送到主机电脑' : '照片仅在本机处理';
    if (photo) ui.photoLabel.textContent = computeMode === 'host' ? '照片已选 · 分析时发送到主机' : '照片已选 · 仅在本机分析';
    ui.computeHint.textContent = computeMode === 'host'
      ? '照片将通过 HTTPS（Cloudflare 中转）发往站点主人的电脑，返回结果后释放。可随时切回“我的设备”。'
      : '当前照片只在你的浏览器中分析，不会发送到网络。';
    status();
    if (computeMode === 'host') void refreshHost();
  });
  $('hostAccessCode').addEventListener('input', event => { hostAccessCode = event.target.value.trim(); });
  $('refreshHostButton').addEventListener('click', () => { void refreshHost(); });
  if (hostAllowed) {
    void refreshHost();
    setInterval(() => { if (document.visibilityState === 'visible') void refreshHost(); }, 30000);
  }
}

async function refreshHost() {
  if (!hostAllowed || hostCheckPending) return;
  hostCheckPending = true;
  try {
    hostState = await getHostHealth(`${hostEndpoint}/api/analyze`, AbortSignal.timeout(8000));
    ui.hostModeStatus.textContent = hostState.online ? (hostState.busy ? '处理中' : '在线') : '离线';
    $('hostAccessCodeWrap').hidden = !hostState.accessCodeRequired;
  } catch {
    hostState = null;
    ui.hostModeStatus.textContent = '连接不上';
  } finally { hostCheckPending = false; }
}

function status(message = '', error = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', error);
}

function setBusy(value) {
  busy = value;
  ui.analyzeButton.disabled = value || !photo;
  ui.analyzeButtonText.textContent = value ? '正在分析你的照片…' : result ? '重新测评这张照片' : '开始颜值测评';
  ui.scanLine.hidden = !value;
  ui.resultPanel.classList.toggle('loading', value);
  ui.resultPanel.setAttribute('aria-busy', String(value));
}

function resetResults() {
  result = null;
  ui.totalScore.textContent = '—';
  ui.scoreRing.classList.remove('complete');
  ui.ringValue.style.strokeDashoffset = '490.088';
  ui.reportBadge.textContent = '等待解锁';
  ui.reportBadge.classList.remove('ready');
  ui.resultTitle.textContent = '你的风格，值得被看见';
  ui.resultSummary.textContent = '上传照片，生成属于你的镜头表现档案。';
  for (const row of ui.dimensions.children) {
    row.querySelector('strong').replaceChildren(document.createTextNode('— '));
    const small = document.createElement('small');
    small.textContent = '/ 100';
    row.querySelector('strong').append(small);
    row.querySelector('.progress-track>span').style.width = '0%';
    row.removeAttribute('title');
  }
  ui.emptyInsight.hidden = false;
  ui.insights.hidden = true;
  ui.downloadButton.hidden = true;
  ui.strengths.replaceChildren();
  ui.suggestions.replaceChildren();
  clearLandmarks();
}

function clearLandmarks() {
  const ctx = ui.landmarkCanvas.getContext('2d');
  ctx.clearRect(0, 0, ui.landmarkCanvas.width, ui.landmarkCanvas.height);
}

function removePhoto() {
  revision++;
  analysisController?.abort();
  analysisController = null;
  photo = null;
  photoBlob = null;
  photoName = '';
  ui.photoPreview.removeAttribute('src');
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  ui.fileInput.value = '';
  ui.previewWrap.hidden = true;
  ui.uploadTrigger.hidden = false;
  ui.clearButton.hidden = true;
  ui.photoHint.replaceChildren();
  ui.photoHint.textContent = '清晰露出五官，效果更好';
  resetResults();
  setBusy(false);
  status();
}

async function loadPhoto(blob, name, isExample = false) {
  removePhoto();
  const thisRevision = revision;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type)) {
    status('请上传 JPG、PNG 或 WebP 图片。HEIC 可先在相册中导出为 JPG。', true);
    return false;
  }
  if (blob.size > maxBytes) {
    status('这张照片超过 12 MB，请压缩后再试。', true);
    return false;
  }
  let inputURL;
  let outputURL;
  try {
    status('正在读取照片…');
    inputURL = URL.createObjectURL(blob);
    const original = new Image();
    original.src = inputURL;
    await original.decode();
    if (thisRevision !== revision) return false;
    if (Math.min(original.naturalWidth, original.naturalHeight) < 160) throw new Error('照片太小，请上传宽和高都至少为 160 像素的图片。');
    if (original.naturalWidth * original.naturalHeight > 60000000) throw new Error('照片像素过大，请缩小到 6000 万像素以内后再试。');
    const scale = Math.min(1, 1600 / Math.max(original.naturalWidth, original.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(original.naturalWidth * scale);
    canvas.height = Math.round(original.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
    const normalized = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (thisRevision !== revision) return false;
    if (!normalized) throw new Error('图片读取失败，请换一张照片再试。');
    outputURL = URL.createObjectURL(normalized);
    const decoded = new Image();
    decoded.src = outputURL;
    await decoded.decode();
    if (thisRevision !== revision) return false;
    photo = decoded;
    photoBlob = normalized;
    objectURL = outputURL;
    outputURL = null;
    photoName = name;
    ui.photoPreview.src = objectURL;
    ui.previewWrap.hidden = false;
    ui.uploadTrigger.hidden = true;
    ui.clearButton.hidden = false;
    ui.photoLabel.textContent = `${isExample ? '示例照片' : '你的照片'} · ${computeMode === 'host' ? '分析时发送到主机' : '仅在本机分析'}`;
    ui.photoHint.textContent = `${original.naturalWidth} × ${original.naturalHeight} · 照片已就绪`;
    setBusy(false);
    status();
    return true;
  } catch (error) {
    if (thisRevision === revision) status(error instanceof DOMException ? '无法读取这张图片，文件可能损坏。请换一张 JPG、PNG 或 WebP 照片。' : error.message, true);
    return false;
  } finally {
    if (inputURL) URL.revokeObjectURL(inputURL);
    if (outputURL) URL.revokeObjectURL(outputURL);
  }
}

function showResult(value) {
  result = value;
  ui.totalScore.textContent = value.score;
  ui.scoreRing.classList.add('complete');
  ui.ringValue.style.strokeDashoffset = String(490.088 * (1 - value.score / 100));
  ui.reportBadge.textContent = '测评完成';
  ui.reportBadge.classList.add('ready');
  ui.resultTitle.textContent = value.score >= 85 ? '这一刻，很有你的风格' : value.score >= 70 ? '找到你的角度，更有型' : '换个角度，发现更多可能';
  ui.resultSummary.textContent = value.summary;
  value.dimensions.forEach((dimension, index) => {
    const row = ui.dimensions.children[index];
    const strong = row.querySelector('strong');
    strong.replaceChildren(document.createTextNode(`${dimension.score} `));
    const small = document.createElement('small');
    small.textContent = '/ 100';
    strong.append(small);
    row.querySelector('.progress-track>span').style.width = `${dimension.score}%`;
    row.title = `${dimension.description} 权重 ${Math.round(dimension.weight * 100)}%。`;
  });
  ui.strengths.replaceChildren(...value.strengths.map(text => {
    const span = document.createElement('span'); span.textContent = text; return span;
  }));
  ui.suggestions.replaceChildren(...value.suggestions.map(text => {
    const li = document.createElement('li'); li.textContent = text; return li;
  }));
  ui.emptyInsight.hidden = true;
  ui.insights.hidden = false;
  ui.downloadButton.hidden = false;
  drawLandmarks();
}

function drawLandmarks() {
  clearLandmarks();
  if (!result || !photo) return;
  const canvas = ui.landmarkCanvas;
  const width = ui.previewWrap.clientWidth;
  const height = ui.previewWrap.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const scale = Math.min(width / photo.naturalWidth, height / photo.naturalHeight);
  const imageWidth = photo.naturalWidth * scale;
  const imageHeight = photo.naturalHeight * scale;
  const offsetX = (width - imageWidth) / 2;
  const offsetY = (height - imageHeight) / 2;
  const line = (indices, close = false) => {
    ctx.beginPath();
    indices.forEach((index, i) => {
      const point = result.landmarks[index];
      const x = offsetX + point.x * imageWidth;
      const y = offsetY + point.y * imageHeight;
      if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (close) ctx.closePath();
    ctx.stroke();
  };
  ctx.strokeStyle = '#dbf3a9a8';
  ctx.lineWidth = .9;
  line([10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109], true);
  line([33,160,158,133,153,144], true);
  line([263,387,385,362,380,373], true);
  line([61,40,37,0,267,270,291,321,314,17,84,91], true);
  ctx.fillStyle = '#e5ffaf';
  for (const index of [1,4,33,133,263,362,61,291,152,10,234,454]) {
    const point = result.landmarks[index];
    ctx.beginPath();
    ctx.arc(offsetX + point.x * imageWidth, offsetY + point.y * imageHeight, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function analyze() {
  if (!photo || busy) return;
  const mode = computeMode;
  if (mode === 'host' && !$('hostConsent').checked) { status('请先勾选同意将这张照片发送到站点主人的电脑。', true); return; }
  if (mode === 'host' && hostState?.accessCodeRequired && !hostAccessCode) { status('请输入站点主人提供的访问码。', true); $('hostAccessCode').focus(); return; }
  const thisRevision = revision;
  const source = photo;
  const sourceBlob = photoBlob;
  const controller = new AbortController();
  analysisController = controller;
  const deadline = setTimeout(() => controller.abort(), 60000);
  resetResults();
  setBusy(true);
  ui.reportBadge.textContent = '正在分析';
  try {
    if (mode === 'device') {
      await initAnalyzer(message => { if (thisRevision === revision) status(message); });
      if (thisRevision !== revision) return;
      status('正在分析五官关键点、清晰度与光线…');
    } else {
      status('正在准备发送到已授权的主机电脑…');
    }
    await nextPaint();
    if (thisRevision !== revision) return;
    let value;
    if (mode === 'host') value = await analyzeOnHost(sourceBlob, controller.signal);
    else value = await analyzePhoto(source);
    if (thisRevision !== revision) return;
    resultMode = mode;
    showResult(value);
    status(mode === 'host' ? '测评完成 · 主机已返回结果' : '测评完成 · 照片未离开你的设备');
    if (matchMedia('(max-width: 820px)').matches) ui.resultPanel.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  } catch (error) {
    if (thisRevision === revision) {
      ui.reportBadge.textContent = '请更换照片';
      status(error.message || '分析失败，请更换清晰的单人正面照再试。', true);
    }
  } finally {
    clearTimeout(deadline);
    if (thisRevision === revision) setBusy(false);
    if (analysisController === controller) analysisController = null;
  }
}

async function analyzeOnHost(blob, signal) {
  if (!hostAllowed) throw new Error('主机服务尚未配置，请切回“我的设备”模式。');
  status('正在通过 HTTPS 连接主机电脑…');
  try {
    return await requestHostAnalysis(`${hostEndpoint}/api/analyze`, blob, hostAccessCode, signal);
  } catch (cause) {
    if (cause.name === 'AbortError') throw new Error('请求已取消或超时，请重试或切回“我的设备”。');
    if (cause instanceof Error && /主机/.test(cause.message)) throw cause;
    throw new Error('无法连接主机电脑。请确认主机在线，或切回“我的设备”模式。', { cause });
  }
}

function roundedRect(ctx, x, y, w, h, r, fill) {
  ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  let line = '';
  for (const char of text) {
    if (ctx.measureText(line + char).width > maxWidth && line) { ctx.fillText(line, x, y); y += lineHeight; line = char; }
    else line += char;
  }
  if (line) ctx.fillText(line, x, y);
  return y + lineHeight;
}

async function downloadReport() {
  if (!result || !photo) return;
  const currentResult = result;
  const currentPhoto = photo;
  const modeLabel = resultMode === 'host' ? '主机电脑分析' : '设备本地分析';
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1620;
  const ctx = canvas.getContext('2d');
  const font = '"Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillStyle = '#f7f8f2'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#25311f'; ctx.font = `bold 40px ${font}`; ctx.fillText('面值  FACE VALUE', 64, 91);
  ctx.font = `18px ${font}`; ctx.fillStyle = '#859372'; ctx.fillText('男生颜值实验室 · 你的镜头表现档案', 64, 132);
  roundedRect(ctx, 48, 171, 984, 510, 24, '#fff');
  roundedRect(ctx, 76, 199, 400, 454, 15, '#f0f3e9');
  ctx.save(); ctx.beginPath(); ctx.roundRect(76, 199, 400, 454, 15); ctx.clip();
  const scale = Math.min(400 / currentPhoto.naturalWidth, 454 / currentPhoto.naturalHeight);
  const width = currentPhoto.naturalWidth * scale, height = currentPhoto.naturalHeight * scale;
  ctx.drawImage(currentPhoto, 76 + (400-width)/2, 199 + (454-height)/2, width, height); ctx.restore();
  ctx.lineWidth = 12; ctx.strokeStyle = '#eff2e6'; ctx.beginPath(); ctx.arc(755, 365, 123, 0, Math.PI*2); ctx.stroke();
  ctx.strokeStyle = '#afcc72'; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(755, 365, 123, -Math.PI/2, -Math.PI/2 + Math.PI*2*currentResult.score/100); ctx.stroke();
  ctx.textAlign = 'center'; ctx.fillStyle = '#2f4224'; ctx.font = `bold 96px ${font}`; ctx.fillText(String(currentResult.score), 755, 383);
  ctx.fillStyle = '#97a386'; ctx.font = `18px ${font}`; ctx.fillText('颜值娱乐分 / 100', 755, 424);
  ctx.fillStyle = '#63774c'; ctx.font = `24px ${font}`; ctx.fillText('每一种风格，都有光。', 755, 552);
  ctx.font = `16px ${font}`; ctx.fillStyle = '#9aa48f'; ctx.fillText(`固定规则 · ${modeLabel} · 无人群排名`, 755, 589); ctx.textAlign = 'left';
  roundedRect(ctx, 48, 705, 984, 380, 24, '#fff');
  ctx.fillStyle = '#34442b'; ctx.font = `bold 25px ${font}`; ctx.fillText('四个维度，认识你的画面', 80, 754);
  currentResult.dimensions.forEach((dimension, index) => {
    const y = 803 + index * 67;
    ctx.font = `20px ${font}`; ctx.fillStyle = '#758667'; ctx.fillText(`${dimension.label}  ·  ${dimension.weight*100}%`, 80, y);
    ctx.textAlign = 'right'; ctx.fillText(`${dimension.score} / 100`, 998, y); ctx.textAlign = 'left';
    roundedRect(ctx, 80, y+15, 918, 8, 4, '#f0f3e9');
    if (dimension.score > 0) roundedRect(ctx, 80, y+15, 918 * dimension.score/100, 8, 4, ['#afca83','#aec3b7','#d0c8a7','#dfc78d'][index]);
  });
  roundedRect(ctx, 48, 1109, 984, 341, 24, '#eef4df');
  ctx.fillStyle = '#516a37'; ctx.font = `bold 25px ${font}`; ctx.fillText('下一张照片，可以这样拍', 80, 1159);
  ctx.font = `21px ${font}`; ctx.fillStyle = '#72825e';
  let y = 1202;
  const tips = currentResult.suggestions.filter(text => !text.startsWith('分数只')).slice(0,3);
  for (const tip of tips) { y = wrapText(ctx, `· ${tip}`, 80, y, 906, 33) + 13; }
  ctx.font = `17px ${font}`; ctx.fillStyle = '#8e9c7d';
  wrapText(ctx, '娱乐评分仅反映照片几何与拍摄质量，不代表客观颜值、个人价值或他人的审美。', 64, 1498, 952, 28);
  ctx.font = `15px ${font}`; ctx.fillText(`生成于 ${new Date().toLocaleString('zh-CN')}  ·  ${modeLabel}`, 64, 1578);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) { status('报告生成失败，请重试。', true); return; }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `面值-测评报告-${currentResult.score}分.png`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

ui.uploadTrigger.addEventListener('click', () => ui.fileInput.click());
ui.replaceButton.addEventListener('click', () => ui.fileInput.click());
ui.clearButton.addEventListener('click', removePhoto);
ui.fileInput.addEventListener('change', () => { const file = ui.fileInput.files[0]; if (file) void loadPhoto(file, file.name); });
ui.analyzeButton.addEventListener('click', analyze);
ui.downloadButton.addEventListener('click', () => { void downloadReport().catch(() => status('报告生成失败，请重试。', true)); });
ui.exampleButton.addEventListener('click', async () => {
  ui.exampleButton.disabled = true;
  const expectedRevision = revision;
  try {
    status('正在载入示例照片…');
    const response = await fetch('./assets/example.jpg');
    if (!response.ok) throw new Error('示例照片加载失败，请直接上传你的照片。');
    const blob = await response.blob();
    if (expectedRevision !== revision) return;
    if (await loadPhoto(blob, '示例照片', true)) await analyze();
  } catch (error) { if (expectedRevision === revision) status(error.message, true); }
  finally { ui.exampleButton.disabled = false; }
});
let dragDepth = 0;
ui.dropZone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; ui.dropZone.classList.add('dragover'); });
ui.dropZone.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
ui.dropZone.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; ui.dropZone.classList.remove('dragover'); } });
ui.dropZone.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; ui.dropZone.classList.remove('dragover');
  const files = [...event.dataTransfer.files];
  if (files.length > 1) { status('每次请选择一张照片。', true); return; }
  if (files[0]) void loadPhoto(files[0], files[0].name);
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
window.addEventListener('resize', drawLandmarks);
$('homeNav').addEventListener('click', () => { ui.uploadTrigger.hidden ? ui.replaceButton.focus() : ui.uploadTrigger.focus(); window.scrollTo({top:0,behavior:'smooth'}); });
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => $(button.dataset.open).showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
if (location.protocol === 'file:') status('请双击 start.bat 启动程序；直接打开 HTML 无法加载本地人脸模型。', true);
setupComputeModes();
