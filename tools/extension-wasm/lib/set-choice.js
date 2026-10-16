// Which printings of a recognized card the user should choose between.
// At listing-photo size the recognizer scores different sets of the same
// Pokémon within a few hundredths of each other, so its top pick is a guess.

// Same-name printings this close to the best one are one guess: the set is not sure. Measured 2026-10-16 on
// the labelled HiBid crops (centre crop, catalog 2026-10-11, 134 reads whose name was right): the true
// printing scored within 0.03 of the best same-name hit 88% of the time, 0.04 93%, 0.05 96%, 0.06 97%.
// Where only one printing was inside 0.05 it was the right one in 13 of 14. Refit with the thresholds in fusion.js.
const NEAR = 0.05;
const MAX_CHOICES = 4;

// "Vibrava δ" and "Vibrava" are the same name for choosing a set.
// "Mew ex" stays different from "Mew": it is another card.
export function choiceName(name) {
  return String(name || "").replace(/\s*[δ★☆]$/u, "").trim().toLowerCase();
}

// Mechanic words that go on a card of the same Pokémon without redrawing the picture. Regional forms
// ("Alolan Raichu") and owner cards ("Team Rocket's Zapdos") are new artwork, so they keep their prefix.
const SUFFIX = /(?:\s+|-)(?:δ\s+delta\s+species|v-union|vstar|vmax|lv\.x|break|prime|legend|gx|ex|v|δ|★|☆)$/iu;
const PREFIX = /^(?:dark|light|shining|radiant)\s+/i;

/** "Pikachu ex", "Pikachu V" and "Dark Pikachu" are all "Pikachu". Never returns an empty name for a non-empty one. */
export function baseName(name) {
  let base = String(name ?? "").trim();
  for (let i = 0; i < 3; i++) {
    const next = base.replace(SUFFIX, "").trim();
    if (!next || next === base) break;
    base = next;
  }
  const bare = base.replace(PREFIX, "").trim();
  return bare || base;
}

function looseName(text) {
  // "Lt.Surge" and "Lt. Surge" are the same name. Other spaces still separate words.
  return String(text || "").toLowerCase().replace(/\.\s*/g, ".");
}

function nameInText(name, blob, extraLetters = 0) {
  const needle = looseName(name).trim();
  const hay = looseName(blob);
  if (needle.length < 3) return false;
  let from = 0;
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 || !/[a-z0-9]/i.test(hay[at - 1]);
    const afterAt = at + needle.length;
    const extra = hay.slice(afterAt, afterAt + extraLetters);
    const glued = extraLetters > 0 && extra.length === extraLetters && /^[a-z]+$/i.test(extra);
    const boundaryAt = glued ? afterAt + extraLetters : afterAt;
    if (extraLetters > 0 && !glued) {
      from = at + 1;
      continue;
    }
    const after = boundaryAt >= hay.length || !/[a-z0-9]/i.test(hay[boundaryAt]);
    // "Sabrina" is not the trainer card when the photo says "Sabrina's Gengar".
    const possessive = hay.slice(boundaryAt, boundaryAt + 2) === "'s";
    if (before && after && !possessive) return true;
    from = at + 1;
  }
  return false;
}

/** The photo's title line is this card. A bracket form may be printed as the base name. */
export function nameAgrees(name, text) {
  const blob = String(text || "").toLowerCase();
  if (!blob) return false;
  if (nameInText(name, blob)) return true;
  const base = String(name || "").replace(/\s*\[[^\]]+\]\s*$/, "").trim();
  return base.toLowerCase() !== String(name || "").trim().toLowerCase() && nameInText(base, blob);
}

/**
 * The title line names this card, including one junk letter glued to the end.
 * "Chimcharw" is Chimchar. "Mewtwo" is not Mew.
 */
export function nameAlmostAgrees(name, text) {
  if (nameAgrees(name, text)) return true;
  const blob = String(text || "").toLowerCase();
  if (!blob) return false;
  if (nameInText(name, blob, 1)) return true;
  const base = String(name || "").replace(/\s*\[[^\]]+\]\s*$/, "").trim();
  return base.toLowerCase() !== String(name || "").trim().toLowerCase() && nameInText(base, blob, 1);
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word));
}

function fourGrams(tokens) {
  const grams = [];
  for (let i = 0; i <= tokens.length - 4; i++) grams.push(tokens.slice(i, i + 4).join(" "));
  return grams;
}

function wordsContain(hay, gram) {
  const need = gram.split(" ");
  for (let i = 0; i <= hay.length - need.length; i++) {
    if (need.every((word, offset) => hay[i + offset] === word)) return true;
  }
  return false;
}

/** Attack names, which stay readable when the effect sentence is glued together. */
export function attacksFromCard(payload) {
  if (!payload || typeof payload !== "object") return [];
  return (payload.attacks || []).map((attack) => attack?.name).filter(Boolean);
}

export function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let col = 1; col <= right.length; col++) rows[0][col] = col;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}

function attackPresent(hay, name) {
  if (wordsContain(hay, name)) return true;
  const need = name.split(" ");
  const letters = name.replace(/[^a-z]/g, "");
  if (letters.length < 8) return false;
  for (let i = 0; i <= hay.length - need.length; i++) {
    let dist = 0;
    for (let j = 0; j < need.length; j++) {
      dist += editDistance(hay[i + j], need[j]);
      if (dist > 1) break;
    }
    if (dist === 1) return true;
  }
  return false;
}

/**
 * The tied card with the most of its attack names printed on the photo.
 * Two names have to be present. A shared name still counts, so Quick Attack
 * plus Volt Tackle picks one Pikachu when another Pikachu only has Quick Attack.
 * One wrong letter in a long name still counts.
 */
export function cardNamedByAttacks(cards, text) {
  if (!Array.isArray(cards) || cards.length < 2) return null;
  const hay = words(text);
  if (hay.length < 2) return null;
  const scored = [];
  for (const card of cards) {
    const names = (card.attacks || []).map((name) => words(name).join(" ")).filter(Boolean);
    const matched = names.filter((name) => attackPresent(hay, name));
    if (matched.length >= 2) scored.push({ card, count: matched.length });
  }
  if (!scored.length) return null;
  const best = Math.max(...scored.map((row) => row.count));
  const top = scored.filter((row) => row.count === best);
  return top.length === 1 ? top[0].card : null;
}

/** Trainer effect and attack text, which is what a photo of the card shows. */
export function descriptionFromCard(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  if (payload.effect) parts.push(String(payload.effect));
  for (const attack of payload.attacks || []) {
    if (attack?.name) parts.push(String(attack.name));
    if (attack?.effect) parts.push(String(attack.effect));
  }
  return parts.filter(Boolean).join(" ");
}

/**
 * The one tied card whose rules are printed on the photo.
 * A phrase that both cards share does not count, and one stock phrase is not enough.
 */
export function cardDescribedInText(cards, text) {
  if (!Array.isArray(cards) || cards.length < 2) return null;
  const hay = words(text);
  if (hay.length < 4) return null;
  const grams = cards.map((card) => fourGrams(words(card?.description)));
  const hits = [];
  for (let i = 0; i < cards.length; i++) {
    const shared = new Set(grams.filter((_, other) => other !== i).flat());
    const unique = grams[i].filter((gram) => !shared.has(gram));
    const matched = unique.filter((gram) => wordsContain(hay, gram));
    // One stock phrase, such as "the Defending Pokémon is now", is not enough.
    if (matched.length >= 2) hits.push(cards[i]);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** The Black Star promo when the star matched and exactly one choice is that set. */
export function onlyPromoChoice(choices) {
  if (!Array.isArray(choices)) return null;
  const promos = choices.filter((choice) => choice?.setCode === "basep");
  return promos.length === 1 ? promos[0] : null;
}

/** The one tied card whose full name is in the photo, or null when the text does not decide. */
export function cardNamedInText(cards, text) {
  if (!Array.isArray(cards) || cards.length < 2) return null;
  const blob = String(text || "").toLowerCase();
  if (!blob) return null;
  const hits = cards.filter((card) => nameInText(card?.name, blob));
  if (!hits.length) return null;
  const longest = Math.max(...hits.map((card) => String(card.name).trim().length));
  const best = hits.filter((card) => String(card.name).trim().length === longest);
  return best.length === 1 ? best[0] : null;
}

export function setChoices(identity, hits, meta) {
  const name = choiceName(identity?.name);
  const sameName = (hits || [])
    .map((h) => ({ card: meta[h.index], score: h.score }))
    .filter(({ card }) => card && choiceName(card.name) === name);

  const best = sameName.length ? sameName[0].score : 0;
  const seen = new Set();
  const choices = [];
  for (const { card, score } of sameName) {
    if (best - score > NEAR) break;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    choices.push(card);
    if (choices.length === MAX_CHOICES) break;
  }
  if (identity?.id && !seen.has(identity.id)) {
    choices.unshift(identity);
    if (choices.length > MAX_CHOICES) choices.pop();
  }
  return choices;
}

// Another card of the same Pokémon (Pikachu ex beside Pikachu V) is a closer call than another printing of
// one card, because the art is only similar. Measured 2026-10-16 on 181 labelled HiBid crops: a different-name
// same-base hit within 0.03 of the best turned up on 9% of reads, and the top name was wrong on 2 of the 181,
// both inside that window. At 0.05 it was 17% of reads with no extra catch, so the window is tighter than NEAR.
const VERSION_NEAR = 0.03;
const MAX_VERSIONS = 3;

/** Cards with the same base name as the accepted one but another full name, close behind its best same-base hit. */
export function versionChoices(identity, hits, meta) {
  const base = baseName(choiceName(identity?.name));
  const own = choiceName(identity?.name);
  if (!base) return [];
  const sameBase = (hits || [])
    .map((h) => ({ card: meta[h.index], score: h.score }))
    .filter(({ card }) => card && baseName(choiceName(card.name)) === base);
  const best = sameBase.length ? sameBase[0].score : 0;
  const seen = new Set();
  const out = [];
  for (const { card, score } of sameBase) {
    if (best - score > VERSION_NEAR) break;
    const name = choiceName(card.name);
    if (name === own || seen.has(name)) continue;
    seen.add(name);
    out.push(card);
    if (out.length === MAX_VERSIONS) break;
  }
  return out;
}
