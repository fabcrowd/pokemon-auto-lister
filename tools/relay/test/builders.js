// Valid contribution builders for tests; pass overrides to break one field.

export const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

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
