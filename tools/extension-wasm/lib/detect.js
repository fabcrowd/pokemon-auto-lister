// YOLO card detection via onnxruntime-web.
// Uses globalThis.ort set by background.js before any of these functions run.

const CONF_THRESH = 0.55;
const NMS_IOU    = 0.45;
// Model was exported with imgsz=640 and simplify=True — input shape is fixed [1,3,640,640].
const MODEL_SIZE = 640;
const PAD_COLOR  = 114; // gray letterbox fill

let _session = null;

// Allow callers to override the confidence floor — small compressed thumbnails
// (FB Marketplace, HiBid lot tiles) often need a lower bar than physical photos.
let _confThresh = CONF_THRESH;
export function setConfThreshold(t) {
  if (typeof t === "number" && t >= 0 && t <= 1) _confThresh = t;
}
export function getConfThreshold() { return _confThresh; }

export async function loadDetector(modelBuffer) {
  _session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ["wasm"],
  });
}

/**
 * Run YOLO detection on an ImageBitmap.
 * Returns boxes in original image coordinates: [{ box:[x1,y1,x2,y2], score }]
 */
export async function detectCards(bitmap) {
  if (!_session) throw new Error("Detector not loaded");

  const origW = bitmap.width;
  const origH = bitmap.height;

  const { canvas: lbCanvas, scale, padX, padY } = letterbox(bitmap, MODEL_SIZE);

  const inputTensor = canvasToTensor(lbCanvas);
  const feeds = { images: inputTensor };
  const results = await _session.run(feeds);

  const outputKey = Object.keys(results)[0];
  let raw = results[outputKey].data;
  let dims = results[outputKey].dims;

  // YOLOv8 output may be [1, attrs, anchors] or [1, anchors, attrs] — normalise
  if (dims[1] <= 84 && dims[1] < dims[2]) {
    // already [1, attrs, anchors] — transpose to [1, anchors, attrs]
    const [, attrs, anchors] = dims;
    const transposed = new Float32Array(anchors * attrs);
    for (let a = 0; a < anchors; a++) {
      for (let k = 0; k < attrs; k++) {
        transposed[a * attrs + k] = raw[k * anchors + a];
      }
    }
    raw = transposed;
    dims = [1, anchors, attrs];
  }

  const [, anchors, attrs] = dims;
  const boxes = [];
  const classCount = Math.max(1, attrs - 4);

  for (let i = 0; i < anchors; i++) {
    const base = i * attrs;
    const cx   = raw[base];
    const cy   = raw[base + 1];
    const w    = raw[base + 2];
    const h    = raw[base + 3];
    // Class 0 is a card front. If that score is weak, another class (a back,
    // or a tight corner) can still be the card in the photo.
    let conf = raw[base + 4] || 0;
    if (conf < _confThresh) {
      for (let c = 1; c < classCount; c++) {
        const score = raw[base + 4 + c];
        if (score > conf) conf = score;
      }
    }
    if (conf < _confThresh) continue;

    // Convert cx/cy/w/h → x1/y1/x2/y2 in letterboxed coords
    const lx1 = cx - w / 2;
    const ly1 = cy - h / 2;
    const lx2 = cx + w / 2;
    const ly2 = cy + h / 2;

    // Map back to original image coords
    const x1 = (lx1 - padX) / scale;
    const y1 = (ly1 - padY) / scale;
    const x2 = (lx2 - padX) / scale;
    const y2 = (ly2 - padY) / scale;

    boxes.push({
      box: [
        Math.max(0, x1),
        Math.max(0, y1),
        Math.min(origW, x2),
        Math.min(origH, y2),
      ],
      score: conf,
    });
  }

  return nms(boxes, NMS_IOU);
}

// --- helpers ---

function letterbox(bitmap, size) {
  // Fit bitmap into a size×size square (preserves aspect ratio, pads the shorter axis).
  const scale = Math.min(size / bitmap.width, size / bitmap.height);
  const newW  = Math.round(bitmap.width  * scale);
  const newH  = Math.round(bitmap.height * scale);
  const padX  = Math.floor((size - newW) / 2);
  const padY  = Math.floor((size - newH) / 2);

  const canvas = new OffscreenCanvas(size, size);
  const ctx    = canvas.getContext("2d", { willReadFrequently: true });

  ctx.fillStyle = `rgb(${PAD_COLOR},${PAD_COLOR},${PAD_COLOR})`;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, padX, padY, newW, newH);

  return { canvas, scale, padX, padY };
}

function canvasToTensor(canvas) {
  const ctx  = canvas.getContext("2d");
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data; // RGBA uint8

  // NCHW float32 in [0, 1]
  const tensor = new Float32Array(3 * height * width);
  const planeSize = height * width;

  for (let i = 0; i < planeSize; i++) {
    tensor[i]                = data[i * 4]     / 255; // R
    tensor[planeSize + i]    = data[i * 4 + 1] / 255; // G
    tensor[planeSize * 2 + i] = data[i * 4 + 2] / 255; // B
  }

  return new ort.Tensor("float32", tensor, [1, 3, height, width]);
}

function iou(a, b) {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

function nms(boxes, threshold) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  const suppressed = new Uint8Array(boxes.length);

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed[i]) continue;
    kept.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (!suppressed[j] && iou(boxes[i].box, boxes[j].box) > threshold) {
        suppressed[j] = 1;
      }
    }
  }
  return kept;
}
