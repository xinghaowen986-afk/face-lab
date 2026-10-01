/** Public client contract. No host credentials are stored in site files. */
export function validateHostResult(result) {
  const score = n => Number.isFinite(n) && n >= 0 && n <= 100;
  const strings = list => Array.isArray(list) && list.length <= 12 && list.every(text => typeof text === 'string' && text.length <= 1200);
  const ids = ['symmetry', 'proportion', 'sharpness', 'lighting'];
  if (!result || !score(result.score) || !Array.isArray(result.dimensions) || result.dimensions.length !== 4
    || !result.dimensions.every((item, i) => item?.id === ids[i] && score(item.score) && Number.isFinite(item.weight) && item.weight >= 0 && item.weight <= 1 && typeof item.description === 'string' && typeof item.label === 'string')
    || typeof result.summary !== 'string' || result.summary.length > 1200
    || !strings(result.strengths) || !strings(result.suggestions)
    || !Array.isArray(result.landmarks) || result.landmarks.length < 455 || result.landmarks.length > 500
    || !result.landmarks.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    throw new Error('主机返回的测评格式不完整，请切回“我的设备”或联系站点主人。');
  }
  return result;
}

export function resolveHostEndpoint(value, pageURL = location.href) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const page = new URL(pageURL);
    const loopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname) && loopback(page.hostname))) return '';
    return url.href.replace(/\/$/, '');
  } catch { return ''; }
}

export async function getHostHealth(endpoint, signal) {
  const url = new URL(endpoint); url.pathname = '/api/health';
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('主机状态暂时不可用');
  const value = await response.json();
  if (typeof value?.online !== 'boolean') throw new Error('主机状态格式无效');
  return value;
}

export async function requestHostAnalysis(endpoint, blob, accessCode, signal) {
  if (!(blob instanceof Blob)) throw new Error('照片尚未准备好，请重新选择图片。');
  if (blob.size > 6 * 1024 * 1024) throw new Error('处理后的照片超过主机的 6 MB 限制，请缩小图片或使用“我的设备”。');
  const headers = { 'Content-Type': blob.type };
  if (accessCode) headers.Authorization = `Bearer ${accessCode}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: blob, mode: 'cors', cache: 'no-store', signal });
  if (!response.ok) {
    const fallback = {401:'主机访问码无效，请重新输入。',403:'主机暂不允许此网站访问。',413:'照片超过主机的大小限制。',429:'主机正忙，请稍后再试或使用“我的设备”。',503:'主机电脑当前离线，请使用“我的设备”。',504:'主机分析超时，请稍后重试。'}[response.status] || '主机分析失败，请稍后重试。';
    let payload;
    try { payload = await response.json(); } catch { /* fallback */ }
    throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message.slice(0, 500) : fallback);
  }
  if (Number(response.headers.get('content-length')) > 512 * 1024) throw new Error('主机响应超出大小限制。');
  return validateHostResult(await response.json());
}
