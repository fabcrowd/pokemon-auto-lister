import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compsForOnePrinting, decidePrice, formatListPrice, NEEDS_REVIEW_THRESHOLD, MIN_COMP_SOURCES } from '../src/pricing/pricing.js';

test('threshold constant is 15%', () => {
  assert.equal(NEEDS_REVIEW_THRESHOLD, 0.15);
  assert.equal(MIN_COMP_SOURCES, 2);
});

test('formatListPrice rounds to the nearest whole dollar', () => {
  assert.equal(formatListPrice(19.4), 19);
  assert.equal(formatListPrice(19.5), 20);
});

test('sources within 15% and high confidence auto-list at median with default multipliers', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    collectr: { market: 104 },
    tcgplayer: { market: 105 },
    ebay: { median: 102 },
  });

  assert.equal(result.action, 'auto');
  assert.equal(result.comps.pokegrade, 100);
  assert.equal(result.comps.collectr, 104);
  assert.equal(result.suggested.mercari, 103);
  assert.equal(result.suggested.ebay, 103);
});

test('pokegrade + collectr alone can auto when they agree', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    collectr: { market: 105 },
    ebay: null,
  });

  assert.equal(result.action, 'auto');
  assert.equal(result.comps.ebay, null);
  assert.equal(result.suggested.mercari, 103);
});

test('pairwise relative spread over 15% forces needs_review', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
    collectr: { market: 130 },
    ebay: { median: 102 },
  });

  assert.equal(result.action, 'needs_review');
});

test('low PokeGrade confidence forces needs_review even when numbers agree', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'low' },
    collectr: { market: 101 },
    ebay: { median: 99 },
  });

  assert.equal(result.action, 'needs_review');
});

test('a single source forces needs_review but still returns partial comps', () => {
  const result = decidePrice({
    pokegrade: { value: 100, confidence: 'high' },
  });

  assert.equal(result.action, 'needs_review');
  assert.equal(result.comps.pokegrade, 100);
  assert.ok(result.suggested.mercari > 0);
});

test('mercariMultiplier and ebayMultiplier apply independently', () => {
  const result = decidePrice(
    {
      pokegrade: { value: 100, confidence: 'high' },
      collectr: { market: 100 },
      ebay: { median: 100 },
    },
    { mercariMultiplier: 1.1, ebayMultiplier: 0.9 },
  );

  assert.equal(result.suggested.mercari, 110);
  assert.equal(result.suggested.ebay, 90);
});

test('1st Edition and Unlimited comps are never medianed together', () => {
  const filtered = compsForOnePrinting({
    justtcg: { market: 38000, printing: '1st Edition Holofoil' },
    tcgdex: { market: 928, printing: 'Unlimited Holofoil' },
  });
  const decision = decidePrice(filtered.sources);
  const numbers = Object.values(decision.comps).filter((value) => typeof value === 'number');
  assert.equal(filtered.ambiguous, true);
  assert.equal(numbers.length, 0);
  assert.equal(decision.suggested, null);
});

test('a chosen printing prices only that printing', () => {
  const filtered = compsForOnePrinting({
    justtcg: { market: 38000, printing: '1st Edition Holofoil' },
    tcgdex: { market: 928, printing: 'unlimited-holofoil' },
    pokemontcgapi: { market: 910, printing: 'Unlimited Holofoil' },
  }, 'Unlimited Holofoil');
  const decision = decidePrice(filtered.sources);
  assert.equal(filtered.ambiguous, false);
  assert.equal(decision.comps.justtcg, null);
  assert.equal(decision.suggested.ebay, 919);
});

test('one source preferring one printing is still ambiguous when its variants price two', () => {
  const filtered = compsForOnePrinting({
    tcgdex: { market: 450, printing: 'unlimited-holofoil', variants: { '1st-edition-holofoil': 9000, 'unlimited-holofoil': 450 } },
    justtcg: { market: 460, printing: 'Unlimited Holofoil', variants: { 'Unlimited Holofoil': 460 } },
  });
  assert.equal(filtered.ambiguous, true);
  assert.deepEqual([...filtered.printings].sort(), ['1steditionholofoil', 'unlimitedholofoil']);
});

test('a chosen printing reprices a source from its variants map', () => {
  const filtered = compsForOnePrinting({
    tcgdex: { market: 450, printing: 'unlimited-holofoil', variants: { '1st-edition-holofoil': 9000, 'unlimited-holofoil': 450 } },
    pokemontcgapi: { market: 455, printing: 'unlimitedHolofoil', variants: { '1stEditionHolofoil': 9200, unlimitedHolofoil: 455 } },
  }, '1st Edition Holofoil');
  const decision = decidePrice(filtered.sources);
  assert.equal(filtered.ambiguous, false);
  assert.equal(decision.comps.tcgdex, 9000);
  assert.equal(decision.comps.pokemontcgapi, 9200);
  assert.equal(decision.action, 'auto');
});

test('a list price that rounds to $0 needs review', () => {
  const decision = decidePrice({ tcgplayer: { market: 0.3 }, tcgdex: { market: 0.31 } });
  assert.equal(decision.action, 'needs_review');
  assert.match(decision.reason, /rounds to \$0/);
  assert.equal(decision.market, 0.31);
});

test('decidePrice ignores string, NaN, and zero comps', () => {
  const stringComp = decidePrice({ pokegrade: { value: '12.50' }, tcgdex: { market: 12 } });
  assert.equal(stringComp.comps.pokegrade, null);
  assert.equal(stringComp.action, 'needs_review');
  assert.equal(stringComp.suggested.mercari, 12);

  const nanComp = decidePrice({ ebay: { median: NaN }, tcgdex: { market: 10 } });
  assert.equal(nanComp.comps.ebay, null);
  assert.equal(nanComp.action, 'needs_review');

  const zeroComp = decidePrice({ tcgplayer: { market: 0 }, tcgdex: { market: 10 }, justtcg: { market: 10.2 } });
  assert.equal(zeroComp.comps.tcgplayer, null);
  assert.equal(zeroComp.action, 'auto');
});

test('decidePrice returns the unrounded median as market', () => {
  const decision = decidePrice({ tcgplayer: { market: 0.46 }, tcgdex: { market: 0.44 } });
  assert.equal(decision.market, 0.45);
  assert.equal(decision.suggested.mercari, 0);
  assert.equal(decidePrice({}).market, null);
});
