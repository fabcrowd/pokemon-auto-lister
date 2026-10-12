export const NEEDS_REVIEW_THRESHOLD = 0.15;
/** Need at least this many numeric comps to auto-draft (PokeGrade + Collectr can pass while eBay/TCG keys are pending). */
export const MIN_COMP_SOURCES = 2;
/** Posted list vs refreshed market: outside this band → needs_review for repost. */
export const PRICE_DRIFT_THRESHOLD = 0.05;

function relativeSpread(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === 0) {
    return hi === 0 ? 0 : Infinity;
  }
  return (hi - lo) / lo;
}

/**
 * Relative drift of market vs posted list price.
 * @param {number} posted
 * @param {number} market
 * @returns {{ delta: number|null, absDelta: number|null, withinBand: boolean }}
 */
export function priceDrift(posted, market, threshold = PRICE_DRIFT_THRESHOLD) {
  if (typeof posted !== 'number' || typeof market !== 'number' || !(posted > 0) || !Number.isFinite(market)) {
    return { delta: null, absDelta: null, withinBand: true };
  }
  const delta = (market - posted) / posted;
  const absDelta = Math.abs(delta);
  return {
    delta,
    absDelta,
    withinBand: absDelta <= threshold,
  };
}

/**
 * Price we already listed / intended to list.
 * @param {{ listPrice?: number, pricedCache?: { suggested?: { mercari?: number, ebay?: number } } }} card
 */
export function postedListPrice(card) {
  if (typeof card?.listPrice === 'number' && Number.isFinite(card.listPrice) && card.listPrice > 0) {
    return card.listPrice;
  }
  const mercari = card?.pricedCache?.suggested?.mercari;
  if (typeof mercari === 'number' && Number.isFinite(mercari) && mercari > 0) {
    return mercari;
  }
  const ebay = card?.pricedCache?.suggested?.ebay;
  if (typeof ebay === 'number' && Number.isFinite(ebay) && ebay > 0) {
    return ebay;
  }
  return null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function formatListPrice(value) {
  return Math.round(value);
}

export function normalizePrinting(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rowPrinting(row) {
  if (!row || typeof row !== 'object') return '';
  return normalizePrinting(row.printing);
}

/**
 * Keep comps from one printing. A 1st Edition price and an Unlimited price are never medianed together.
 * When the caller has not chosen and the sources disagree, the largest agreeing group is priced and
 * the result is marked ambiguous. A tie prices nothing.
 * @param {Record<string, object|null>} sources
 * @param {string} [chosenPrinting]
 */
export function compsForOnePrinting(sources = {}, chosenPrinting) {
  const groups = new Map();
  for (const [key, row] of Object.entries(sources)) {
    const printing = rowPrinting(row);
    if (!printing) continue;
    const keys = groups.get(printing) || [];
    keys.push(key);
    groups.set(printing, keys);
  }

  const wanted = normalizePrinting(chosenPrinting);
  let selected = null;
  if (wanted) {
    selected = wanted;
  } else if (groups.size === 1) {
    selected = [...groups.keys()][0];
  } else if (groups.size > 1) {
    const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (ranked[0][1].length > ranked[1][1].length) selected = ranked[0][0];
  }

  const ambiguous = groups.size > 1 && !wanted;
  const next = {};
  for (const [key, row] of Object.entries(sources)) {
    const printing = rowPrinting(row);
    const otherEdition = Boolean(selected) && printing && printing !== selected;
    const untaggedWhileSplit = !printing && groups.size > 1;
    const unresolvedTie = !selected && groups.size > 1;
    next[key] = otherEdition || untaggedWhileSplit || unresolvedTie ? null : row ?? null;
  }
  return {
    sources: next,
    printing: selected,
    ambiguous,
    printings: [...groups.keys()],
  };
}

export function decidePrice(
  { pokegrade, collectr, tcgplayer, ebay, rapidapi, justtcg, pokewallet, pokemontcgapi, tcgdex, cardmarket } = {},
  multipliers = {},
) {
  const mercariMultiplier = multipliers.mercariMultiplier ?? 1.0;
  const ebayMultiplier = multipliers.ebayMultiplier ?? 1.0;

  const comps = {
    pokegrade: pokegrade?.value ?? null,
    collectr: collectr?.market ?? null,
    tcgplayer: tcgplayer?.market ?? null,
    ebay: ebay?.median ?? null,
    rapidapi: rapidapi?.market ?? null,
    justtcg: justtcg?.market ?? null,
    pokewallet: pokewallet?.market ?? null,
    pokemontcgapi: pokemontcgapi?.market ?? null,
    tcgdex: tcgdex?.market ?? null,
    cardmarket: cardmarket?.market ?? null,
  };

  const availableEntries = Object.entries(comps).filter(([, value]) => value !== null && value !== undefined);
  const available = availableEntries.map(([, value]) => value);
  const missingSource = available.length < MIN_COMP_SOURCES;
  const lowConfidence = pokegrade?.confidence === 'low';

  let action = 'auto';
  let reason = `sources agree within ${NEEDS_REVIEW_THRESHOLD * 100}%`;

  if (missingSource) {
    action = 'needs_review';
    const missing = Object.entries(comps)
      .filter(([, value]) => value === null || value === undefined)
      .map(([name]) => name);
    reason = `missing comps: ${missing.join(', ') || 'unknown'} — only ${available.length} of ${MIN_COMP_SOURCES}+ sources available`;
  } else if (lowConfidence) {
    action = 'needs_review';
    reason = 'low PokeGrade confidence';
  } else {
    for (let i = 0; i < available.length; i += 1) {
      for (let j = i + 1; j < available.length; j += 1) {
        if (relativeSpread(available[i], available[j]) > NEEDS_REVIEW_THRESHOLD) {
          action = 'needs_review';
          reason = `comps disagree by more than ${NEEDS_REVIEW_THRESHOLD * 100}%`;
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
