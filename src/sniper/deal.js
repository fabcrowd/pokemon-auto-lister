/**
 * Decide whether a Mercari ask is a heart / worklist / suspect / skip.
 *
 * @param {number|null|undefined} marketValue
 * @param {number|null|undefined} askPrice
 * @param {{ heartRatio?: number, worklistMin?: number, suspectRatio?: number }} [thresholds]
 * @returns {'heart'|'worklist'|'suspect'|'skip'}
 */
export function decideDeal(marketValue, askPrice, thresholds = {}) {
  const heartRatio = thresholds.heartRatio ?? 1.25;
  const worklistMin = thresholds.worklistMin ?? 1.15;
  const suspectRatio = thresholds.suspectRatio ?? 5;

  if (
    typeof marketValue !== 'number' ||
    !Number.isFinite(marketValue) ||
    marketValue <= 0 ||
    typeof askPrice !== 'number' ||
    !Number.isFinite(askPrice) ||
    askPrice <= 0
  ) {
    return 'skip';
  }

  const ratio = marketValue / askPrice;

  if (ratio >= suspectRatio) {
    return 'suspect';
  }
  if (ratio >= heartRatio) {
    return 'heart';
  }
  if (ratio >= worklistMin) {
    return 'worklist';
  }
  return 'skip';
}

/**
 * Parse the first money token from Mercari tile text.
 * Discounted tiles may concatenate "$99.75$105" — use only the first amount.
 *
 * @param {string|null|undefined} text
 * @returns {number|null}
 */
export function parseFirstMoney(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  const match = text.replace(/,/g, '').match(/\$?\s*(-?\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Pick market value for a strategy mode from a PokeGrade-style result.
 *
 * @param {{ value?: number|null, graded?: Record<string, number|null> }} pokeResult
 * @param {{ mode: string, grade?: number }} strategy
 * @returns {number|null}
 */
export function marketForStrategy(pokeResult, strategy) {
  if (!pokeResult || !strategy) {
    return null;
  }
  if (strategy.mode === 'raw-crack') {
    const raw = pokeResult.value;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  if (strategy.mode === 'graded-under') {
    const grade = strategy.grade;
    if (grade == null) {
      return null;
    }
    const graded = pokeResult.graded ?? {};
    const key = `psa${grade}`;
    const alt = `PSA ${grade}`;
    const value = graded[key] ?? graded[alt] ?? graded[String(grade)] ?? null;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return null;
}
