// Ask-the-user logic: when a scanned card is a guess, which cards to offer,
// how to search the catalog by hand, and what a saved answer looks like.

import { confTier } from "./card-display.js";
import { inEra } from "./era.js";
import { exactTotalHits, setSizes } from "./card-number.js";
import { choiceName } from "./set-choice.js";

const VIAS = ["candidates", "search", "wrong-card"];
const JPEG_DATA_URL = /^data:image\/jpeg;base64,/;

/** The scanner is guessing: it abstained, the set is open, or confidence is low. */
export function isUnsure(card) {
  if (!card || card.cardBack || card.setConfirmed === true) return false;
  return Boolean(card.abstain) || (card.setChoices?.length || 0) > 1 || confTier(card.confidence) === "low";
}

/** Set choices first, then the scanner's guess, then other printings of the name. */
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
  for (const choice of choices) add(byId.get(choice.id) ?? choice);
  if (card.identity?.id) add(byId.get(card.identity.id) ?? card.identity);
  const name = choiceName(card.identity?.name ?? choices[0]?.name);
  if (name) {
    for (const row of catalog) {
      if (out.length >= limit) break;
      if (choiceName(row.name) === name) add(row);
    }
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
