/**
 * Live pricing smoke for the scanner path.
 * Uses a fixed identity (no PokeGrade credit) and real JustTCG if JUSTTCG_API_KEY is set.
 *
 * Usage: node --env-file=.env scripts/scan-pricing-smoke.mjs
 */
import { createJustTcgClient } from '../src/pricing/justTcg.js';
import { scanAndPrice } from '../src/scan/scanAndPrice.js';

const identity = {
  name: 'Charizard',
  set: 'Base Set',
  setCode: 'base1',
  number: '4',
  game: 'pokemon',
};

async function main() {
  if (!process.env.JUSTTCG_API_KEY) {
    console.error('JUSTTCG_API_KEY missing — cannot prove live pricing');
    process.exit(2);
  }

  const justTcgClient = createJustTcgClient();
  const result = await scanAndPrice({
    frontImagePath: 'dummy-front.jpg',
    pokegradeClient: {
      evaluateFrontImage: async () => ({
        identity,
        value: null,
        confidence: 'high',
        grading: null,
      }),
    },
    justTcgClient,
  });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        identity: result.identity,
        comps: result.comps,
        suggested: result.suggested,
        pricingSources: result.pricingSources,
        reason: result.reason,
      },
      null,
      2,
    ),
  );

  if (!result.pricingSources?.includes('justtcg') || typeof result.comps?.justtcg !== 'number') {
    console.error('FAIL: JustTCG did not return a market number');
    process.exit(1);
  }
  console.log(`OK: JustTCG market $${result.comps.justtcg}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
