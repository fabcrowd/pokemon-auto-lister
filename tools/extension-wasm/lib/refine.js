// Second look at grid tiles the first read could not settle: the page's own (larger) picture of the card instead of the
// screenshot crop. Pure decisions only; background.js does the fetching and the embedding.

const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
};

/**
 * Where the page keeps the picture of one grid tile: its own <img> src, or that of another view of the same tile (the slot
 * behind the image has no src). `views` are the finder's candidates for one screen: { rect: { x, y, w, h }, src?,
 * naturalWidth?, naturalHeight? }.
 * @returns { src, naturalWidth, naturalHeight } | null
 */
export function tileSource(views, index) {
  const own = views[index];
  const pick = (v) => (v?.src && v.naturalHeight > 0 ? { src: v.src, naturalWidth: v.naturalWidth, naturalHeight: v.naturalHeight } : null);
  const direct = pick(own);
  if (direct || !own?.rect) return direct;
  for (let j = 0; j < views.length; j++) {
    if (j !== index && views[j]?.rect && overlap(own.rect, views[j].rect) > 0.5) {
      const twin = pick(views[j]);
      if (twin) return twin;
    }
  }
  return null;
}

export const MAX_REFINED = 40;
export const MIN_SOURCE_GAIN = 1.15;

/**
 * Indexes of the cards worth a look at their source picture: still unsettled, a picture known, and that picture holds
 * at least MIN_SOURCE_GAIN times the pixels of the screenshot crop the first read used. In page order, at most `max`.
 * @param hints per card: { src, naturalHeight, shownPx } or null
 */
export function sourceRefineOrder(cards, hints, max = MAX_REFINED) {
  const out = [];
  cards.forEach((card, i) => {
    const hint = hints[i];
    if (out.length < max && card?.lowCertainty && hint?.src && hint.naturalHeight > hint.shownPx * MIN_SOURCE_GAIN) out.push(i);
  });
  return out;
}

/**
 * The card after a read of its source picture. A settled source read replaces the guess; a source read that is still
 * unsettled but names a closest card replaces the guess's ranking (more pixels, better ranking); anything else leaves the
 * card as it was. Where the card sits on the page always stays.
 * @param asGuess (read) => low-certainty guess, or the read unchanged
 */
export function mergeSourceRead(card, read, asGuess) {
  if (!read || read.cardBack) return card;
  const place = { box: card.box, score: card.score, docBox: card.docBox, via: card.via };
  if (!read.abstain) return { ...read, ...place, refinedFromSource: true };
  const guess = asGuess(read);
  return guess?.lowCertainty ? { ...guess, ...place, refinedFromSource: true } : card;
}

/** Whether a decoded source picture is shaped like one card (width over height), so the whole picture can be the tile. */
export const looksLikeCard = (width, height) => height > 0 && width / height >= 0.62 && width / height <= 0.80;
