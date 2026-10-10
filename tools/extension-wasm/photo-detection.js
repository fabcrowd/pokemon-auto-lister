const CARD_RATIO_MIN = 0.55;
const CARD_RATIO_MAX = 0.95;
const MAX_PHOTO_AREA_FRACTION = 0.65;

export function imageToViewportTransform(rect, imageWidth, imageHeight, render = {}) {
  if (!rect || imageWidth <= 0 || imageHeight <= 0) return null;
  const fit = render.fit || "fill";
  const containScale = Math.min(rect.w / imageWidth, rect.h / imageHeight);
  const coverScale = Math.max(rect.w / imageWidth, rect.h / imageHeight);

  let scaleX;
  let scaleY;
  if (fit === "background") {
    const scale = backgroundScale(render.size, imageWidth, imageHeight, rect, containScale, coverScale);
    if (!scale) return null;
    [scaleX, scaleY] = scale;
  } else if (fit === "contain" || fit === "cover" || fit === "scale-down") {
    const scale = fit === "cover" ? coverScale : fit === "scale-down" ? Math.min(1, containScale) : containScale;
    scaleX = scale;
    scaleY = scale;
  } else if (fit === "none") {
    scaleX = 1;
    scaleY = 1;
  } else {
    scaleX = rect.w / imageWidth;
    scaleY = rect.h / imageHeight;
  }

  const position = parsePosition(render.position);
  if (!position) return null;
  const [positionX, positionY] = position;
  const displayWidth = imageWidth * scaleX;
  const displayHeight = imageHeight * scaleY;
  return {
    left: rect.x + (rect.w - displayWidth) * positionX,
    top: rect.y + (rect.h - displayHeight) * positionY,
    scaleX,
    scaleY,
  };
}

export function mapPhotoBoxToViewport(box, transform, clipRect = null) {
  if (!Array.isArray(box) || box.length !== 4 || !transform) return null;
  let [x1, y1, x2, y2] = box;
  x1 = transform.left + x1 * transform.scaleX;
  x2 = transform.left + x2 * transform.scaleX;
  y1 = transform.top + y1 * transform.scaleY;
  y2 = transform.top + y2 * transform.scaleY;
  if (clipRect) {
    x1 = Math.max(clipRect.x, x1);
    y1 = Math.max(clipRect.y, y1);
    x2 = Math.min(clipRect.x + clipRect.w, x2);
    y2 = Math.min(clipRect.y + clipRect.h, y2);
  }
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function backgroundScale(size, imageWidth, imageHeight, rect, containScale, coverScale) {
  const value = String(size || "auto").trim().toLowerCase();
  if (value === "cover") return [coverScale, coverScale];
  if (value === "contain") return [containScale, containScale];
  const tokens = value.split(/\s+/);
  if (tokens.length > 2) return null;
  if (tokens.some((token) => token !== "auto" && !/^-?\d+(?:\.\d+)?(?:%|px)$/.test(token))) return null;
  const parseLength = (token, axis, other) => {
    if (!token || token === "auto") return null;
    const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
    if (percent) return (axis === "x" ? rect.w : rect.h) * Number(percent[1]) / 100;
    const pixels = token.match(/^(\d+(?:\.\d+)?)px$/);
    if (pixels) return Number(pixels[1]);
    return null;
  };
  const width = parseLength(tokens[0], "x");
  const height = parseLength(tokens[1], "y");
  if (width !== null && height !== null) return [width / imageWidth, height / imageHeight];
  if (width !== null) return [width / imageWidth, width / imageWidth];
  if (height !== null) return [height / imageHeight, height / imageHeight];
  if (tokens.every((token) => token === "auto")) return [1, 1];
  return null;
}

function parsePosition(position = "50% 50%") {
  const words = String(position).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [0.5, 0.5];
  if (words.length > 2) return null;
  if (words.length === 1) {
    if (words[0] === "top" || words[0] === "bottom") words.unshift("center");
    else words.push("center");
  }
  const fraction = (token) => {
    if (token === "center") return 0.5;
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return 1;
    const percent = token.match(/^(-?\d+(?:\.\d+)?)%$/);
    return percent ? Number(percent[1]) / 100 : null;
  };
  let [x, y] = words;
  if ((x === "top" || x === "bottom") && (y === "left" || y === "right")) [x, y] = [y, x];
  const fx = fraction(x);
  const fy = fraction(y);
  return fx === null || fy === null ? null : [fx, fy];
}

export function filterPhotoDetections(detections, imageWidth, imageHeight) {
  if (!Array.isArray(detections) || imageWidth <= 0 || imageHeight <= 0) return [];

  const imageArea = imageWidth * imageHeight;
  return detections.filter(({ box }) => {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return false;

    const [x1, y1, x2, y2] = box;
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) return false;

    const ratio = width / height;
    const areaFraction = (width * height) / imageArea;
    return ratio >= CARD_RATIO_MIN && ratio <= CARD_RATIO_MAX &&
      areaFraction <= MAX_PHOTO_AREA_FRACTION;
  });
}
