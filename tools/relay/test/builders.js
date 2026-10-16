// Valid contribution builders for tests; pass overrides to break one field.

/**
 * A structurally valid JPEG skeleton (no real image data): SOI, SOF, SOS, a few scan bytes, EOI.
 * marker 0xC0 is baseline, 0xC2 progressive.
 */
export function jpegBytes({ width = 100, height = 140, components = 3, marker = 0xc0, end = [0xff, 0xd9] } = {}) {
  const sof = [0xff, marker, 0, 8 + 3 * components, 8, height >> 8, height & 255, width >> 8, width & 255, components];
  for (let c = 0; c < components; c++) sof.push(c + 1, 0x11, 0);
  const sos = [0xff, 0xda, 0, 6 + 2 * components, components];
  for (let c = 0; c < components; c++) sos.push(c + 1, 0);
  sos.push(0, 63, 0);
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, ...sof, ...sos, 1, 2, 3, 4, ...end]);
}

export const jpegB64 = (opts) => jpegBytes(opts).toString("base64");

export const JPEG_B64 = jpegB64();

export function card(over = {}) {
  return {
    box: [0.1, 0.2, 0.3, 0.4],
    crop: JPEG_B64,
    answer: { cardId: "base1-4" },
    scanner: { cardId: "base1-5", confidence: 0.8, stripe: "high" },
    source: "pick",
    ...over,
  };
}

export function contribution(over = {}) {
  return {
    v: 1,
    install: "123e4567-e89b-42d3-a456-426614174000",
    split: "teach",
    photoId: "00000000000000a1",
    day: "2026-10-15",
    model: { clip: "0123456789abcdef", crop: 2 },
    catalog: "fedcba9876543210",
    cards: [card()],
    ...over,
  };
}
