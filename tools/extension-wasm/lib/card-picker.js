// Ask-the-user logic: when a scanned card is a guess, which cards to offer,
// how to search the catalog by hand, and what a saved answer looks like.

import { isUnsure } from "./card-display.js";
import { inEra } from "./era.js";
import { exactTotalHits, setSizes } from "./card-number.js";
import { choiceName } from "./set-choice.js";

const VIAS = ["candidates", "search", "wrong-card"];
const JPEG_DATA_URL = /^data:image\/jpeg;base64,/;

export { isUnsure };

/** Up to `limit` distinct catalog rows from a crop's search hits, best first, even when none was good enough to name. */
export function closestMatches(hits, meta, limit = 5) {
  const out = [];
  const seen = new Set();
  for (const hit of hits || []) {
    const row = Array.isArray(meta) ? meta[hit?.index] : null;
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** The card the user corrected before first, then set choices, then the scanner's guess, then other printings of the name. */
export function candidatesFor(card, meta, limit = 5) {
  if (!card) return [];
  const catalog = Array.isArray(meta) ? meta : [];
  const choices = card.setChoices || [];
  const byId = choices.length || card.identity?.id ? new Map(catalog.map((row) => [row.id, row])) : null;
  const out = [];
  const seen = new Set();
  const add = (row) => {
    if (!row?.id || seen.has(row.id) || out.length >= limit) return;
    seen.add(row.id);
    out.push(row);
  };
  if (card.referencedId) add(catalog.find((row) => row.id === card.referencedId));
  for (const choice of choices) add(byId.get(choice.id) ?? choice);
  if (card.identity?.id) add(byId.get(card.identity.id) ?? card.identity);
  const name = choiceName(card.identity?.name ?? choices[0]?.name);
  if (name) {
    for (const row of catalog) {
      if (out.length >= limit) break;
      if (choiceName(row.name) === name) add(row);
    }
  }
  if (!card.cardBack && card.nearest?.length) {
    const rows = new Map(catalog.map((row) => [row.id, row]));
    for (const id of card.nearest) add(rows.get(id));
  }
  return out;
}

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// "004" and "4" are one number; "TG01" and "TG1" too.
function numberKey(number) {
  return String(number ?? "").toLowerCase().split("/")[0].replace(/^([a-z]*)0+(?=\d)/, "$1");
}

/** "4/102", "#4", "4" and "charizard 4" → name words plus an optional number and set total. */
export function parseSearch(query) {
  const words = [];
  let number = null;
  let total = null;
  for (const token of String(query ?? "").split(/\s+/)) {
    if (!token) continue;
    const slash = token.match(/^#?([a-z0-9]+)\/(\d+)$/i);
    const hashed = token.match(/^#([a-z0-9]+)$/i);
    if (slash) {
      number = slash[1].toLowerCase();
      total = slash[2];
    } else if (hashed) {
      number = hashed[1].toLowerCase();
      total = null;
    } else if (/^\d+$/.test(token) || /^[a-z]{1,4}\d+$/i.test(token)) {
      number = token.toLowerCase();
      total = null;
    } else {
      const parts = normalize(token).split(" ").filter(Boolean);
      words.push(...parts);
    }
  }
  return { words, number, total };
}

const _sizes = new WeakMap();
function sizesOf(meta) {
  if (!_sizes.has(meta)) _sizes.set(meta, setSizes(meta));
  return _sizes.get(meta);
}

/**
 * Catalog rows matching a typed query, best first. Cards from the scan's era
 * come first, then sets whose size matches a typed total, then closer names.
 */
export function findCards(meta, query, { era = null, limit = 20 } = {}) {
  const { words, number, total } = parseSearch(query);
  if (!Array.isArray(meta) || (!words.length && !number)) return [];
  const wantNumber = number ? numberKey(number) : null;
  const phrase = words.join(" ");
  const hits = [];
  meta.forEach((card, index) => {
    if (!card) return;
    if (wantNumber && numberKey(card.number) !== wantNumber) return;
    let quality = 3;
    if (words.length) {
      const name = normalize(card.name);
      if (!words.every((word) => name.includes(word))) return;
      quality = name === phrase ? 0 : name.startsWith(phrase) ? 1 : 2;
    }
    hits.push({ card, index, quality, era: era && !inEra(card, era) ? 1 : 0, sized: 1 });
  });
  if (total && number && hits.length) {
    const rows = hits.map((hit) => hit.card);
    for (const at of exactTotalHits(rows, { number, total }, sizesOf(meta))) hits[at].sized = 0;
  }
  hits.sort((a, b) => a.era - b.era || a.sized - b.sized || a.quality - b.quality || a.index - b.index);
  return hits.slice(0, limit).map((hit) => hit.card);
}

/** A catalog image, else the pokemontcg.io one, else nothing to show. */
export function thumbUrl(card) {
  if (card?.imageUrl) return card.imageUrl;
  if (card?.setCode && card?.number) {
    return `https://images.pokemontcg.io/${encodeURIComponent(card.setCode)}/${encodeURIComponent(card.number)}.png`;
  }
  return null;
}

/** What the scanner said about a card, kept apart from what the user later chose. */
export function guessOf(card) {
  return {
    id: card?.identity?.id ?? null,
    confidence: Number.isFinite(card?.confidence) ? card.confidence : null,
    abstain: Boolean(card?.abstain),
    choiceIds: (card?.setChoices || []).map((choice) => choice.id),
    catalogTop: Number.isFinite(card?.catalogTop) ? card.catalogTop : null,
  };
}

/** Where the listing was, without the query string, hash or login that could identify the user. */
export function pageUrlForStorage(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return null;
  }
}

export function matchesLabel(count) {
  if (!Number.isInteger(count)) return "";
  if (count === 0) return "No matches";
  return count === 1 ? "1 match" : `${count} matches`;
}

/** One saved answer. Throws on a record that would be useless as a label. */
export function correctionRecord({ ts, scanId, index, pageUrl, guess, pickedId, via, crop, extVersion }) {
  if (!VIAS.includes(via)) throw new Error(`correction via must be one of ${VIAS.join(", ")}`);
  if (typeof pickedId !== "string" || !pickedId) throw new Error("correction needs a pickedId");
  const linked = typeof scanId === "string" && scanId && Number.isInteger(index) && index >= 0;
  return {
    // One crop has one answer: a later pick for the same scan card replaces the earlier one.
    ...(linked ? { id: `${scanId}:${index}` } : {}),
    ts: Number(ts),
    scanId: linked ? scanId : null,
    index: linked ? index : null,
    pageUrl: pageUrlForStorage(pageUrl),
    guess: {
      id: guess?.id ?? null,
      confidence: Number.isFinite(guess?.confidence) ? guess.confidence : null,
      abstain: Boolean(guess?.abstain),
      choiceIds: Array.isArray(guess?.choiceIds) ? guess.choiceIds.filter((id) => typeof id === "string") : [],
      catalogTop: Number.isFinite(guess?.catalogTop) ? guess.catalogTop : null,
    },
    pickedId,
    via,
    crop: typeof crop === "string" && JPEG_DATA_URL.test(crop) ? crop : null,
    extVersion: typeof extVersion === "string" ? extVersion : null,
  };
}

export function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pickLabel(card) {
  return [card.name, card.set || card.setCode, card.number ? `number ${card.number}` : ""].filter(Boolean).join(", ");
}

/** A row of thumbnail buttons. Each value is escaped here because the result goes into innerHTML. */
export function renderPickList(cards, idx) {
  return (cards || []).map((card) => {
    const label = escHtml(pickLabel(card));
    const url = thumbUrl(card);
    const image = url
      ? `<img src="${escHtml(url)}" alt="${label}" loading="lazy" width="63" height="88">`
      : `<span class="pick-blank" aria-hidden="true"></span>`;
    const sub = [card.set || card.setCode, card.number ? `#${card.number}` : ""].filter(Boolean).join(" ");
    return `<button type="button" class="pick-card" data-pick="${escHtml(card.id)}" data-idx="${idx}" aria-label="${label}" title="${label}">${image}<span class="pick-name">${escHtml(card.name)}</span><span class="pick-sub">${escHtml(sub)}</span></button>`;
  }).join("");
}

export function unrecognisedLabel(count, expanded) {
  return `${count} ${count === 1 ? "card" : "cards"} not recognised — ${expanded ? "Hide" : "Show"}`;
}

/** The crop picture a scan may carry for a card; anything but a JPEG data URL is ignored. */
export function cropThumb(card) {
  const crop = card?.crop;
  return typeof crop === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(crop) ? crop : null;
}

/** One disclosure button over the compact rows (already-escaped HTML) of cards nothing could be said about. */
export function renderUnrecognisedGroup(rowsHtml, count, expanded) {
  if (!count) return "";
  return `<div class="unrec">
    <button type="button" class="unrec-toggle" data-unrec-toggle aria-expanded="${expanded}" aria-controls="unrec-list">${escHtml(unrecognisedLabel(count, expanded))}</button>
    <div id="unrec-list" class="unrec-list"${expanded ? "" : " hidden"}>${rowsHtml}</div>
  </div>`;
}
