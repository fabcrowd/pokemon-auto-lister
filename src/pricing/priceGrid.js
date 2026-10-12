/**
 * Try price-grid sources in order; the first non-null grid wins.
 * JustTCG's grid has per-condition prices but a 100-requests/day free tier, so a keyless
 * source behind it keeps `/api/price-grid` answering when the quota runs out.
 */
export function chainPriceGrids(...clients) {
  const sources = clients.filter((c) => typeof c?.getPriceGrid === 'function');
  return {
    async getPriceGrid(identity) {
      let lastError = null;
      let answered = false;
      for (const source of sources) {
        try {
          const grid = await source.getPriceGrid(identity);
          if (grid) return grid;
          answered = true;
        } catch (err) {
          lastError = err;
          console.error('price-grid source failed, trying next:', err.message);
        }
      }
      // An outage is only the answer when no source could say "no data".
      if (lastError && !answered) throw lastError;
      return null;
    },
  };
}
