const CARD_RATIO_MIN = 0.55;
const CARD_RATIO_MAX = 0.95;
const MAX_PHOTO_AREA_FRACTION = 0.65;

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
