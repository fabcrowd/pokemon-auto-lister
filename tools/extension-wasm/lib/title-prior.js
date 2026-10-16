// A listing's own title ("Charizard 4/102 Base Set Holo PSA 9") is a weak hint about which card the
// photo shows. On any listing it reorders what the matcher already proposed (set choices, candidates, the
// "Other version?" menu) and prefills the search box; it never adds a candidate and never makes an unsure
// row sure. Two things go further, each on a narrow condition:
//  - a title naming only the other look-alike version (Pikachu ex, not Pikachu V) swaps the row to that
//    version with its price, but only when the listing photo holds exactly one card, so a multi-card lot
//    is never re-read from a single title. Confidence does not change.
//  - a title naming the card, its number and its set confirms a printing that was held below "high" only
//    because nothing but the picture chose it, and lifts it back to the confidence it had.

import { isUnsure } from "./card-display.js";
import { choiceName } from "./set-choice.js";
import { swapVersion } from "./card-display.js";
import { UNCONFIRMED_SET_CONFIDENCE_CAP } from "./fusion.js";

const SITES = "ebay|mercari|hibid|tcgplayer|pricecharting|pokellector|etsy|amazon(?:\\.com)?|whatnot|facebook marketplace|shop ?goodwill(?:\\.com)?";
const SITE_SUFFIX = new RegExp(`\\s*[|\\-\\u2013\\u2014\\u00b7:]\\s*(?:[^|\\-\\u2013\\u2014\\u00b7:]*\\bon\\s+)?(?:${SITES})\\b[^|]*$`, "i");
// Cookie and consent dialogs, challenge pages and error pages put their own h1 on the page.
const BANNER = /^(?:privacy|your privacy|cookie|we use cookies|we value your privacy|accept|manage (?:cookie|consent)|consent|sign in|log ?in|access denied|just a moment|error page|security (?:check|measure)|pardon our|verify|captcha|robot)|\bcookies?\b.{0,40}$/i;
const LOT = /\b(?:lots?|bundles?|bulk|collections?|assorted|mystery|random|set of \d+|\d+\s*(?:x\s*)?cards?)\b/i;
const GRADERS = /^(?:psa|bgs|cgc|sgc|ace|hga|tag|gma|pcg)$/;

/** The title without the site's name, "for sale online" filler or a banner dialog's heading. "" when nothing is left. */
export function cleanListingTitle(raw) {
  let title = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!title || BANNER.test(title)) return "";
  for (let i = 0; i < 3 && SITE_SUFFIX.test(title); i++) title = title.replace(SITE_SUFFIX, "").trim();
  title = title.replace(/^details about\s+/i, "").replace(/\s+for sale(?: online)?$/i, "").trim();
  return BANNER.test(title) ? "" : title;
}

/** The page's usable titles, in the order h1, og:title, document title, each cleaned and without repeats. */
export function listingTitles(page) {
  const out = [];
  for (const raw of [page?.h1, page?.ogTitle, page?.title]) {
    const title = cleanListingTitle(raw);
    if (title && !out.includes(title)) out.push(title);
  }
  return out;
}

function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// "004" and "4" are one number; "TG01" and "TG1" too.
function numberKey(number) {
  return String(number ?? "").toLowerCase().split("/")[0].replace(/^([a-z]*)0+(?=\d)/, "$1");
}

function numbersIn(text) {
  const found = [];
  const add = (number, total) => {
    const key = numberKey(number);
    if (key && !found.some((f) => f.number === key)) found.push({ number: key, total: total ?? null });
  };
  for (const m of text.matchAll(/(?<![\w/])#?([a-z]{0,5}\d{1,4})\s*\/\s*([a-z]{0,3}\d{1,4})(?![\w/])/gi)) {
    if (!GRADERS.test(m[1].toLowerCase())) add(m[1], m[2].replace(/^0+(?=\d)/, ""));
  }
  for (const m of text.matchAll(/(?<![\w/])#([a-z]{0,5}\d{1,4})\b/gi)) add(m[1], null);
  for (const m of text.matchAll(/(?<![\w/#])([a-z]{2,5}\d{2,4})\b/gi)) {
    if (!GRADERS.test(m[1].toLowerCase().replace(/\d+$/, ""))) add(m[1], null);
  }
  return found;
}

/** Name words, collector number and total, and whether the title is a lot or names several numbers. */
export function parseListingTitle(title) {
  const clean = cleanListingTitle(title);
  const numbers = numbersIn(clean);
  return {
    title: clean,
    tokens: words(clean),
    number: numbers.length === 1 ? numbers[0].number : null,
    total: numbers.length === 1 ? numbers[0].total : null,
    lot: LOT.test(clean) || numbers.length > 1,
  };
}

function hasRun(haystack, needle) {
  if (!needle.length) return false;
  for (let at = 0; at + needle.length <= haystack.length; at++) {
    if (!needle.every((word, i) => haystack[at + i] === word)) continue;
    // "Sabrina's Gengar" is not Sabrina.
    if (haystack[at + needle.length] === "s" && haystack.length > at + needle.length + 1) continue;
    return true;
  }
  return false;
}

function nameWords(name) {
  const w = words(choiceName(name));
  return w.join("").length >= 3 ? w : [];
}

/** Names found in the title that are not just part of a longer name found there too. */
function namesInTitle(tokens, names) {
  const found = new Map();
  for (const name of names) {
    const w = nameWords(name);
    if (w.length && hasRun(tokens, w)) found.set(w.join(" "), w);
  }
  const all = [...found.values()];
  return all.filter((w) => !all.some((other) => other !== w && other.length > w.length && hasRun(other, w)));
}

/** The one catalog name the title mentions (longest if it contains another), else null. */
export function nameFromTitle(parsed, names) {
  if (!parsed?.tokens?.length || parsed.lot) return null;
  const maximal = namesInTitle(parsed.tokens, names);
  if (maximal.length !== 1) return null;
  const key = maximal[0].join(" ");
  return [...names].find((name) => nameWords(name).join(" ") === key) ?? null;
}

/** The offered version whose name is the only card name the title mentions, else null. The shown card is a candidate too. */
function versionNamedByTitle(card, parsed, knownNames) {
  const offered = card.versionChoices;
  if (!offered?.length || !card.identity?.name || !parsed?.tokens?.length || parsed.lot) return null;
  const maximal = namesInTitle(parsed.tokens, [card.identity.name, ...offered.map((c) => c?.name), ...knownNames]);
  if (maximal.length !== 1) return null;
  const want = maximal[0].join(" ");
  if (nameWords(card.identity.name).join(" ") === want) return null;
  return offered.find((c) => nameWords(c?.name).join(" ") === want) ?? null;
}

/**
 * The candidates with the one the title names first; same objects, nothing added or removed.
 * Unchanged when the title is a lot, names more than one card, or names none of them.
 */
export function rerankByTitle(candidates, parsed, knownNames = []) {
  if (!Array.isArray(candidates) || candidates.length < 2 || !parsed?.tokens?.length || parsed.lot) return candidates;
  const maximal = namesInTitle(parsed.tokens, [...candidates.map((c) => c?.name), ...knownNames]);
  if (maximal.length !== 1) return candidates;
  const want = maximal[0].join(" ");
  const named = (c) => nameWords(c?.name).join(" ") === want;
  if (!candidates.some(named)) return candidates;
  const setWords = (c) => words(c?.set);
  const rank = (c) => (named(c) ? 0 : 8)
    + (parsed.number && numberKey(c?.number) === parsed.number ? 0 : parsed.number ? 2 : 0)
    + (hasRun(parsed.tokens, setWords(c)) ? 0 : 1);
  const order = candidates.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i);
  return order.every((o, i) => o.i === i) ? candidates : order.map((o) => o.c);
}

/** The title names this card, its collector number and its set, so it confirms this printing. */
export function titleConfirmsPrinting(parsed, card) {
  if (!parsed?.tokens?.length || parsed.lot || !parsed.number || !card?.number) return false;
  if (numberKey(card.number) !== parsed.number) return false;
  const name = nameWords(card.name);
  const set = words(card.set);
  return name.length > 0 && set.length > 0 && hasRun(parsed.tokens, name) && setNamed(parsed.tokens, set, parsed.number);
}

// "Base Set 2" is not "Base Set": a digit right after the set's words belongs to the set unless it is the card's number.
function setNamed(tokens, set, number) {
  for (let at = 0; at + set.length <= tokens.length; at++) {
    if (!set.every((word, i) => tokens[at + i] === word)) continue;
    const next = tokens[at + set.length];
    if (next === undefined || !/^\d{1,2}$/.test(next) || numberKey(next) === number) return true;
  }
  return false;
}

function queryFor(parsed, name) {
  const number = parsed.number ? parsed.number + (parsed.total ? `/${parsed.total}` : "") : "";
  return [name, number].filter(Boolean).join(" ");
}

/** One card in the whole scan and, when the scan says how many boxes its photo held, exactly one. */
function isSoleCardInPhoto(card, cards) {
  return cards.length === 1 && (card.photoBoxes === undefined || card.photoBoxes === 1);
}

/**
 * Cards with the title prior applied. Only on a listing page. Set choices, candidates and the version menu are
 * reordered, an unsure row gets titleQuery for its search box, and a sole card in a single-card photo may be
 * shown as the other version the title names. Confidence is never raised except as described in the header.
 */
export function applyTitlePrior(cards, { kind, page, knownNames = [], log = () => {} } = {}) {
  if (kind !== "listing" || !Array.isArray(cards)) return cards;
  const parsedTitles = listingTitles(page).map(parseListingTitle);
  if (!parsedTitles.length) return cards;
  return cards.map((card) => {
    if (!card) return card;
    let next = card;
    for (const parsed of parsedTitles) {
      const setChoices = rerankByTitle(card.setChoices, parsed, knownNames);
      const candidates = rerankByTitle(card.candidates, parsed, knownNames);
      if (setChoices === card.setChoices && candidates === card.candidates) continue;
      next = { ...card, ...(setChoices !== card.setChoices ? { setChoices } : {}), ...(candidates !== card.candidates ? { candidates } : {}) };
      log(`title prior: moved ${(candidates !== card.candidates ? candidates : setChoices)[0].name} to front`);
      break;
    }
    // Pikachu ex or Pikachu V: a title that names only the other version decides, with that card's price, but
    // only for the one card of a single-card photo. Elsewhere the title just moves that version up the menu.
    // Confidence stays where it was, so the row is not made surer by a listing's say-so.
    const soleCard = isSoleCardInPhoto(card, cards);
    for (const parsed of parsedTitles) {
      const version = versionNamedByTitle(next, parsed, knownNames);
      if (!version) continue;
      if (soleCard) {
        next = swapVersion(next, version.id);
        log(`title prior: showing ${version.name}`);
      } else {
        const reordered = [version, ...next.versionChoices.filter((c) => c !== version)];
        next = { ...next, versionChoices: reordered };
        log(`title prior: moved ${version.name} to front of the version menu`);
      }
      break;
    }
    const heldBack = card.setUnconfirmed === true && card.identity?.id && card.confidenceBeforeSetCap > card.confidence
      && card.confidence === UNCONFIRMED_SET_CONFIDENCE_CAP;
    if (heldBack && parsedTitles.some((parsed) => titleConfirmsPrinting(parsed, card.identity))) {
      const { confidenceBeforeSetCap, ...rest } = next;
      next = { ...rest, confidence: confidenceBeforeSetCap, setUnconfirmed: false };
    }
    if (isUnsure(card)) {
      for (const parsed of parsedTitles) {
        const name = nameFromTitle(parsed, knownNames);
        if (name) {
          next = { ...next, titleQuery: queryFor(parsed, name) };
          break;
        }
      }
    }
    return next;
  });
}
