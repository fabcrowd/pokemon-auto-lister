export const MIN_BOX_PX = 8;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function defaultBox(width, height) {
  const w = Math.max(MIN_BOX_PX, Math.round(width * 0.3));
  const h = Math.max(MIN_BOX_PX, Math.round(height * 0.4));
  const x1 = Math.round((width - w) / 2);
  const y1 = Math.round((height - h) / 2);
  return [x1, y1, x1 + w, y1 + h];
}

export function keyStep(width, height) {
  return Math.max(1, Math.round(Math.max(width, height) / 100));
}

export function moveBox([x1, y1, x2, y2], dx, dy, width, height) {
  const mx = clamp(dx, -x1, width - x2);
  const my = clamp(dy, -y1, height - y2);
  return [x1 + mx, y1 + my, x2 + mx, y2 + my];
}

// The top-left corner stays put so that Shift+arrow always grows or shrinks the same two edges.
export function resizeBox([x1, y1, x2, y2], dw, dh, width, height) {
  return [
    x1,
    y1,
    clamp(x2 + dw, Math.min(x1 + MIN_BOX_PX, width), width),
    clamp(y2 + dh, Math.min(y1 + MIN_BOX_PX, height), height),
  ];
}

export function boxFromCorners(a, b, width, height) {
  const x = [a.x, b.x].map((v) => Math.round(clamp(v, 0, width))).sort((p, q) => p - q);
  const y = [a.y, b.y].map((v) => Math.round(clamp(v, 0, height))).sort((p, q) => p - q);
  return [x[0], y[0], x[1], y[1]];
}
