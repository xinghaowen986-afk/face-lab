/**
 * Face Lab — local, deterministic photo presentation heuristics.
 * Scores are entertainment preferences, not objective attractiveness measures.
 * No image leaves the browser. No demographic attributes are inferred.
 */

const MODEL_URL = new URL('./vendor/face_landmarker.task', import.meta.url).href;
const WASM_URL = new URL('./vendor/wasm', import.meta.url).href;
const DIMENSIONS = [
  { id: 'symmetry', label: '画面对称', weight: 0.35 },
  { id: 'proportion', label: '比例参考', weight: 0.25 },
  { id: 'sharpness', label: '照片清晰', weight: 0.20 },
  { id: 'lighting', label: '光线表现', weight: 0.20 },
];
let analyzer = null;
let initialization = null;

const clamp = (value, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, value));
const rounded = (value, places = 2) => Number(value.toFixed(places));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function failure(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

/** Initialize the locally bundled MediaPipe face landmarker once. */
export async function initAnalyzer(onStatus = () => {}) {
  if (analyzer) return analyzer;
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      onStatus('正在加载本地人脸模型…');
      const { FaceLandmarker, FilesetResolver } = await import('./vendor/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      analyzer = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 2,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
      onStatus('模型已就绪，照片仅在本机分析');
      return analyzer;
    } catch (cause) {
      analyzer = null;
      throw failure('MODEL_LOAD_FAILED', '人脸模型加载失败。请通过随附的本地启动程序打开页面，并确认 vendor 文件夹完整，然后重试。', cause);
    } finally {
      initialization = null;
    }
  })();
  return initialization;
}

function getImageSize(source) {
  return {
    width: source.naturalWidth || source.videoWidth || source.width || 0,
    height: source.naturalHeight || source.videoHeight || source.height || 0,
  };
}

function faceRectangle(landmarks, width, height) {
  const xs = landmarks.map((point) => point.x * width);
  const ys = landmarks.map((point) => point.y * height);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const marginX = (maxX - minX) * 0.04;
  const marginY = (maxY - minY) * 0.04;
  const x = clamp(minX - marginX, 0, width - 1);
  const y = clamp(minY - marginY, 0, height - 1);
  return {
    x, y,
    width: Math.max(1, Math.min(width, maxX + marginX) - x),
    height: Math.max(1, Math.min(height, maxY + marginY) - y),
  };
}

/** Sample only the detected face crop at a fixed analysis resolution. */
function sampleImage(source, landmarks, width, height) {
  const crop = faceRectangle(landmarks, width, height);
  const scale = Math.min(256 / crop.width, 256 / crop.height, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(16, Math.round(crop.width * scale));
  canvas.height = Math.max(16, Math.round(crop.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw failure('CANVAS_UNAVAILABLE', '浏览器无法读取照片，请换用新版 Chrome 或 Edge。');
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  let data;
  try {
    data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (cause) {
    throw failure('IMAGE_UNREADABLE', '照片无法读取，请选择保存在电脑上的 JPG、PNG 或 WebP 图片。', cause);
  }
  const w = canvas.width;
  const h = canvas.height;
  const luminance = new Float64Array(w * h);
  const histogram = new Uint32Array(256);
  let total = 0;
  let dark = 0;
  let bright = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (let index = 0; index < luminance.length; index++) {
    const offset = index * 4;
    const value = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
    luminance[index] = value;
    histogram[Math.round(value)]++;
    total += value;
    if (value <= 6) dark++;
    if (value >= 249) bright++;
    if (index % w < w / 2) { leftTotal += value; leftCount++; }
    else { rightTotal += value; rightCount++; }
  }
  let laplacianSum = 0;
  let laplacianSquared = 0;
  let laplacianCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const index = y * w + x;
      const value = luminance[index - 1] + luminance[index + 1] + luminance[index - w] + luminance[index + w] - 4 * luminance[index];
      laplacianSum += value;
      laplacianSquared += value * value;
      laplacianCount++;
    }
  }
  const percentile = (fraction) => {
    let count = 0;
    for (let value = 0; value < histogram.length; value++) {
      count += histogram[value];
      if (count >= luminance.length * fraction) return value;
    }
    return 255;
  };
  return {
    imageWidth: width,
    imageHeight: height,
    faceWidthPixels: crop.width,
    faceHeightPixels: crop.height,
    faceCrop: Object.fromEntries(Object.entries(crop).map(([key, value]) => [key, rounded(value, 1)])),
    sharpnessVariance: Math.max(0, laplacianSquared / laplacianCount - (laplacianSum / laplacianCount) ** 2),
    brightness: total / luminance.length,
    darkClipping: dark / luminance.length,
    brightClipping: bright / luminance.length,
    p10: percentile(0.1),
    p90: percentile(0.9),
    lightingBalance: Math.abs(leftTotal / leftCount - rightTotal / rightCount),
  };
}

/**
 * Pure scoring function. Landmarks are MediaPipe normalized points; metrics are
 * sampled face-crop measurements. Keep imageWidth/imageHeight for aspect ratio.
 * This makes no inference about age, gender, ethnicity, health, or personality.
 */
export function computeScoring(landmarks, metrics = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 455 || !landmarks.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    throw failure('INVALID_LANDMARKS', '人脸关键点不完整，请更换清晰的正面单人照片。');
  }
  const width = metrics.imageWidth || 1;
  const height = metrics.imageHeight || 1;
  const points = landmarks.map((point) => ({ x: point.x * width, y: point.y * height }));
  const eyeA = midpoint(points[33], points[133]);
  const eyeB = midpoint(points[263], points[362]);
  const eyeMidpoint = midpoint(eyeA, eyeB);
  const eyeDistance = distance(eyeA, eyeB);
  const faceWidth = distance(points[234], points[454]);
  const faceHeight = distance(points[10], points[152]);
  if (Math.min(eyeDistance, faceWidth, faceHeight) <= 0.0001) {
    throw failure('INVALID_LANDMARKS', '无法得到稳定的人脸比例，请换一张清晰的正面照片。');
  }
  const axisX = { x: (eyeB.x - eyeA.x) / eyeDistance, y: (eyeB.y - eyeA.y) / eyeDistance };
  const axisY = { x: -axisX.y, y: axisX.x };
  const project = (point) => ({
    x: (point.x - eyeMidpoint.x) * axisX.x + (point.y - eyeMidpoint.y) * axisX.y,
    y: (point.x - eyeMidpoint.x) * axisY.x + (point.y - eyeMidpoint.y) * axisY.y,
  });
  const projected = points.map(project);
  const pairs = [[33, 263], [133, 362], [159, 386], [145, 374], [61, 291], [234, 454], [93, 323], [172, 397], [70, 300], [105, 334]];
  const pairErrors = pairs.map(([a, b]) => Math.hypot((projected[a].x + projected[b].x) / faceWidth, (projected[a].y - projected[b].y) / faceHeight));
  const symmetryError = pairErrors.reduce((sum, error) => sum + error, 0) / pairErrors.length;
  const symmetryScore = clamp(100 - symmetryError * 270);

  // These loose template references are explicit product choices, not ideals.
  const eyeWidthRatio = eyeDistance / faceWidth;
  const mouthWidthRatio = distance(points[61], points[291]) / faceWidth;
  const heightWidthRatio = faceHeight / faceWidth;
  const ratioPreference = (value, center, tolerance) => clamp(100 - Math.abs(value - center) / tolerance * 45);
  const proportionScore = (
    ratioPreference(eyeWidthRatio, 0.46, 0.18) * 0.40 +
    ratioPreference(mouthWidthRatio, 0.36, 0.18) * 0.35 +
    ratioPreference(heightWidthRatio, 1.35, 0.65) * 0.25
  );

  const sharpnessVariance = Math.max(0, metrics.sharpnessVariance ?? 180);
  const resolutionFactor = clamp((metrics.faceWidthPixels ?? 256) / 160, 0.55, 1);
  const sharpnessScore = clamp(Math.log1p(sharpnessVariance) / Math.log1p(900) * 100) * resolutionFactor;
  const darkClipping = clamp(metrics.darkClipping ?? 0, 0, 1);
  const brightClipping = clamp(metrics.brightClipping ?? 0, 0, 1);
  const lightingBalance = Math.max(0, metrics.lightingBalance ?? 0);
  // Mean brightness is reported, but not graded: skin tone is not exposure.
  const lightingScore = clamp(100 - Math.min(70, (darkClipping + brightClipping) * 220)
    - Math.max(0, 80 - (metrics.p90 ?? 180)) * 0.55
    - Math.max(0, (metrics.p10 ?? 70) - 195) * 0.35
    - Math.min(18, lightingBalance * 0.30));

  const scores = { symmetry: symmetryScore, proportion: proportionScore, sharpness: sharpnessScore, lighting: lightingScore };
  const descriptions = {
    symmetry: '比较 10 组关键点在照片中的左右投影差异；已校正画面倾斜，侧脸和表情仍会影响结果。',
    proportion: '按程序自定的宽松比例模板比较眼距、嘴宽和脸部高宽比，仅代表模板偏好。',
    sharpness: '分析人脸区域的边缘细节，并考虑人脸在原图中的像素尺寸；锐化和噪点可能影响分数。',
    lighting: '检查人脸区域的极暗、过曝像素和左右亮度差；平均亮度只作展示，不直接计分。',
  };
  const dimensions = DIMENSIONS.map((dimension) => ({ ...dimension, score: Math.round(scores[dimension.id]), description: descriptions[dimension.id] }));
  const score = Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0));
  const summary = score >= 85
    ? '这张照片在本程序的呈现指标上表现较好。换一张照片，分数也可能变化。'
    : score >= 70
      ? '这张照片的呈现比较完整，光线、角度和清晰度还有尝试空间。'
      : '本次结果更容易受拍摄条件影响，建议用清晰、光线均匀的正面照再试一次。';
  const strengthText = {
    symmetry: '左右关键点在这张照片中的投影较为接近。',
    proportion: '画面比例与本程序选定的参考模板较为接近。',
    sharpness: '照片保留了较多可辨识的人脸边缘细节。',
    lighting: '人脸区域的极端曝光和左右明暗差相对较少。',
  };
  const strengths = dimensions.filter((item) => item.score >= 70).sort((a, b) => b.score - a.score).slice(0, 2).map((item) => strengthText[item.id]);
  if (!strengths.length) strengths.push('已成功识别人脸关键点，可以尝试不同拍摄条件比较照片。');
  const suggestions = [];
  if (symmetryScore < 83) suggestions.push('镜头与眼睛齐平，正对镜头，放松表情；侧脸会降低画面对称分。');
  if (sharpnessScore < 80) suggestions.push('擦净镜头、对焦眼睛并保持稳定；尽量使用原图，避免截图或多次压缩。');
  if ((metrics.faceWidthPixels ?? 256) < 160) suggestions.push('让人脸在照片中占据更多面积，或上传分辨率更高的原图。');
  if (lightingScore < 83) suggestions.push('面向柔和窗光，避免强逆光和头顶直射灯，减少脸部大面积明暗反差。');
  if (proportionScore < 80) suggestions.push('可将相机稍微拿远，再适度裁切，减少近距离广角对五官比例的影响。');
  if (suggestions.length === 0) suggestions.push('试试相同光线下的不同表情与发型，比较哪张照片更符合你的个人喜好。');
  suggestions.push('分数只反映这张照片与程序模板的匹配程度，不代表真实颜值、个人价值或他人的审美。');

  return {
    score, dimensions, summary, strengths, suggestions,
    landmarks: landmarks.map(({ x, y, z = 0 }) => ({ x, y, z })),
    measurements: {
      symmetryError: rounded(symmetryError, 4),
      symmetryPairCount: pairs.length,
      eyeWidthRatio: rounded(eyeWidthRatio, 3),
      mouthWidthRatio: rounded(mouthWidthRatio, 3),
      heightWidthRatio: rounded(heightWidthRatio, 3),
      template: { eyeWidthRatio: 0.46, mouthWidthRatio: 0.36, heightWidthRatio: 1.35 },
      imageWidth: width,
      imageHeight: height,
    },
    imageQuality: {
      sharpnessVariance: rounded(sharpnessVariance, 1),
      brightness: rounded(metrics.brightness ?? 128, 1),
      darkClipping: rounded(darkClipping, 4),
      brightClipping: rounded(brightClipping, 4),
      lightingBalance: rounded(lightingBalance, 1),
      faceWidthPixels: Math.round(metrics.faceWidthPixels ?? 256),
      faceHeightPixels: Math.round(metrics.faceHeightPixels ?? 256),
      faceCrop: metrics.faceCrop || null,
    },
  };
}

/** Analyze a decoded image/canvas. The model and pixels stay in this browser. */
export async function analyzePhoto(imageSource) {
  const { width, height } = getImageSize(imageSource);
  if (!width || !height) throw failure('IMAGE_NOT_READY', '照片尚未读取完成，请重新选择图片。');
  if (Math.min(width, height) < 160) throw failure('IMAGE_TOO_SMALL', '照片太小，请选择宽和高都至少为 160 像素的清晰图片。');
  const faceAnalyzer = analyzer || await initAnalyzer();
  let detection;
  try {
    detection = faceAnalyzer.detect(imageSource);
  } catch (cause) {
    throw failure('DETECTION_FAILED', '这张照片暂时无法分析，请更换清晰的 JPG、PNG 或 WebP 单人正面照。', cause);
  }
  const faces = detection.faceLandmarks || [];
  if (faces.length === 0) throw failure('NO_FACE', '没有识别到清晰人脸。请用光线充足、无遮挡的单人正面照。');
  if (faces.length > 1) throw failure('MULTIPLE_FACES', '照片中有多张人脸，请裁剪后只保留一个人再试。');
  const landmarks = faces[0];
  return computeScoring(landmarks, sampleImage(imageSource, landmarks, width, height));
}
