export const NEEDS_REVIEW_THRESHOLD = 0.15;

function relativeSpread(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === 0) {
    return hi === 0 ? 0 : Infinity;
  }
  return (hi - lo) / lo;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function formatListPrice(value) {
  return Math.round(value);
}

export function decidePrice({ pokegrade, tcgplayer, ebay } = {}, multipliers = {}) {
  const mercariMultiplier = multipliers.mercariMultiplier ?? 1.0;
  const ebayMultiplier = multipliers.ebayMultiplier ?? 1.0;

  const comps = {
    pokegrade: pokegrade?.value ?? null,
    tcgplayer: tcgplayer?.market ?? null,
    ebay: ebay?.median ?? null,
  };

  const available = Object.values(comps).filter((value) => value !== null && value !== undefined);
  const missingSource = available.length < 3;
  const lowConfidence = pokegrade?.confidence === 'low';

  let action = 'auto';
  let reason = 'sources agree';

  if (missingSource) {
    action = 'needs_review';
    reason = 'missing source';
  } else if (lowConfidence) {
    action = 'needs_review';
    reason = 'low PokeGrade confidence';
  } else {
    for (let i = 0; i < available.length; i += 1) {
      for (let j = i + 1; j < available.length; j += 1) {
        if (relativeSpread(available[i], available[j]) > NEEDS_REVIEW_THRESHOLD) {
          action = 'needs_review';
          reason = 'pairwise spread exceeds threshold';
        }
      }
    }
  }

  let suggested = null;
  if (available.length > 0) {
    const base = median(available);
    suggested = {
      mercari: formatListPrice(base * mercariMultiplier),
      ebay: formatListPrice(base * ebayMultiplier),
    };
  }

  return { action, reason, comps, suggested };
}
