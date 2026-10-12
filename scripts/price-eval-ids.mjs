#!/usr/bin/env node
/**
 * Price every exactly-identified card in an eval_lots report through the app's
 * JustTCG client, and record whether the lookup landed on the right product.
 *
 *   node --env-file=.env scripts/price-eval-ids.mjs --report=.tmp/lots-dev.json [--out=...] [--max-calls=40]
 *
 * Results are cached in --out (default data/detect-hibid-real/prices.json) and never
 * re-fetched: the JustTCG free tier allows 100 calls/day and 1,000/month.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJustTcgClient, justTcgSetName, sameSetName } from '../src/pricing/justTcg.js';
import { createTcgdexClient } from '../src/pricing/tcgdex.js';
import { createPokemonTcgApiClient, pokemontcgIdCandidates } from '../src/pricing/pokemonTcgApi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normNumber(value) {
  const raw = String(value || '').split('/')[0].trim().toLowerCase();
  return raw.replace(/^0+(?=.)/, '');
}

/** True when a JustTCG match is the same printed card as the identity (set + number). */
export function sameProduct(identity, match) {
  if (!identity || !match) return false;
  const number = normNumber(identity.number);
  return Boolean(number) && sameSetName(justTcgSetName(identity), match.set) && number === normNumber(match.number);
}

/**
 * Wrap fetch so callers can tell a failed request from "no match": getMarketPrice swallows both as null,
 * and caching a quota hit or a dropped connection as a miss would never be retried.
 */
export function trackedFetch(fetchFn = fetch) {
  let error = null;
  return {
    async fetchImpl(url, init) {
      try {
        const res = await fetchFn(url, init);
        // The last response decides: clients retry transient 5xx, and a recovered retry is not an outage.
        error = res.ok ? null : `HTTP ${res.status}`;
        return res;
      } catch (err) {
        error = err.message;
        throw err;
      }
    },
    takeError() {
      const e = error;
      error = null;
      return e;
    },
  };
}

/** TCGdex is looked up by catalog id, so a price is right only when it came back for that same id. */
export function tcgdexCorrect(id, result) {
  return Boolean(result) && result.productId === id;
}

/** pokemontcg.io is looked up by the catalog id's mapped spellings; any other card is a wrong price. */
export function pokemontcgCorrect(id, result) {
  return Boolean(result?.tcgplayer?.market) && pokemontcgIdCandidates(id).includes(result.pokemontcgId);
}

const SOURCES = {
  justtcg: { out: 'prices.json', maxCalls: 40, pauseMs: 6500 },
  tcgdex: { out: 'prices-tcgdex.json', maxCalls: 500, pauseMs: 300 },
  pokemontcg: { out: 'prices-pokemontcg.json', maxCalls: 500, pauseMs: 2500 },
};

/** [id, identity] pairs for exact identifications that are not yet in the cache. */
export function idsToPrice(report, cache) {
  const todo = new Map();
  for (const image of report.images || []) {
    const truth = new Set((image.truth || []).filter(Boolean));
    (image.preds || []).forEach(([, id], i) => {
      const identity = image.identities?.[i];
      if (id && truth.has(id) && identity && !(id in cache) && !todo.has(id)) todo.set(id, identity);
    });
  }
  return [...todo.entries()];
}

async function main() {
  const opt = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
  const reportPath = opt('report');
  if (!reportPath) throw new Error('--report=<eval_lots report.json> is required');
  const source = opt('source', 'justtcg');
  const conf = SOURCES[source];
  if (!conf) throw new Error(`--source must be one of ${Object.keys(SOURCES).join(', ')}`);
  if (source === 'justtcg' && !process.env.JUSTTCG_API_KEY) throw new Error('JUSTTCG_API_KEY missing (run with --env-file=.env)');
  const outPath = path.resolve(opt('out', path.join(ROOT, 'data', 'detect-hibid-real', conf.out)));
  const maxCalls = Number(opt('max-calls', conf.maxCalls));

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  let cache = {};
  try {
    cache = JSON.parse(await readFile(outPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const tracked = trackedFetch();
  const fetchImpl = tracked.fetchImpl;
  const lookup = {
    justtcg: () => createJustTcgClient({ fetchImpl }).getMarketPrice,
    tcgdex: () => createTcgdexClient({ fetchImpl }).getMarketPrice,
    pokemontcg: () => createPokemonTcgApiClient({ fetchImpl }).getPrices,
  }[source]();
  const isCorrect = {
    justtcg: (id, identity, result) => sameProduct(identity, result),
    tcgdex: (id, identity, result) => tcgdexCorrect(id, result),
    pokemontcg: (id, identity, result) => pokemontcgCorrect(id, result),
  }[source];

  const todo = idsToPrice(report, cache).slice(0, maxCalls);
  let done = 0;
  for (const [id, identity] of todo) {
    // JustTCG free tier allows 10 requests/minute; TCGdex has no published limit, so stay polite.
    if (done) await sleep(conf.pauseMs);
    tracked.takeError();
    let result = null;
    try {
      result = await lookup({ ...identity, productId: id });
    } catch (err) {
      tracked.takeError();
      console.error(`stopping: ${source} ${err.message} on ${id}; ${Object.keys(cache).length} cached`);
      break;
    }
    const failure = tracked.takeError();
    // TCGdex and pokemontcg.io answer 404 for cards they lack; that is a real "no price", not an outage.
    if (failure && !(source !== 'justtcg' && failure === 'HTTP 404')) {
      console.error(`stopping: ${source} ${failure} on ${id}; ${Object.keys(cache).length} cached`);
      break;
    }
    cache[id] = {
      market: result?.market ?? result?.tcgplayer?.market ?? null,
      correct: isCorrect(id, identity, result),
      identity,
      match: result ? { name: result.name, set: result.set, number: result.number } : null,
      fetchedAt: new Date().toISOString(),
    };
    console.log(`${id}: ${cache[id].market ?? '-'} ${cache[id].correct ? 'ok' : 'WRONG/NONE'} ${JSON.stringify(cache[id].match)}`);
    await writeFile(outPath, JSON.stringify(cache, null, 1));
    done += 1;
  }
  const pending = idsToPrice(report, cache).length;
  console.log(`priced ${done} this run; ${pending} still pending; cache at ${outPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
