// The why-record: what the scanner believed about a confirmed card and why. It rides on the card (`card.why`), is sent
// back inside the guess when the user corrects the row, and is stored locally with the correction. It never leaves the
// device: lib/contribution.js has no field for it. Small by design (a few hundred bytes).

import { confTier } from "./card-display.js";
import { confirmRowFor } from "./fusion.js";
import { choiceName } from "./set-choice.js";

export const WHY_SOURCES = Object.freeze(["picture", "number", "setHint", "stamp", "promoted", "correction", "user"]);
const TITLES = ["agree", "contradict", "silent"];
const TIERS = ["high", "medium", "low"];
const MAX_TEXT = 40;
const MAX_JSON = 700;

const round3 = (value) => Math.round(value * 1000) / 1000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** The top hit's cosine, its lead over the best card with ANOTHER name (same-name printings never count), and that rival. */
export function leadOf(hits, meta) {
  const top = hits?.[0];
  if (!top || !meta?.[top.index]) return { cos: 0, lead: 0, rival: null, rivalName: null };
  const topKey = choiceName(meta[top.index].name);
  const rival = (hits || []).slice(1).find((hit) => meta[hit.index] && choiceName(meta[hit.index].name) !== topKey);
  const row = rival ? meta[rival.index] : null;
  return { cos: top.score, lead: rival ? top.score - rival.score : top.score, rival: row?.id ?? null, rivalName: row?.name ?? null };
}

// The next two distinct names after the top card's own, for "Closest others".
function othersOf(hits, meta) {
  const top = hits?.[0] && meta?.[hits[0].index];
  const seen = new Set([choiceName(top?.name)]);
  const out = [];
  for (const hit of (hits || []).slice(1)) {
    const name = meta?.[hit.index]?.name;
    if (!name || seen.has(choiceName(name))) continue;
    seen.add(choiceName(name));
    out.push(name);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * @param {{src: string, hits: object[], ranked?: {id: string, score: number}[], meta: object[], height?: number,
 *   tags?: {clip: string, crop: number, catalog: string}, ref?: {id: string, cos: number, n?: number, ts?: number, bar?: number}}} input
 * hits are the hits the confirm rule saw (after memory). For a correction the cosine is the reference's, and the lead is
 * its lead over the catalog's own top card.
 */
export function whyOf({ src, hits, ranked, meta, height = 0, tags, ref }) {
  const lead = leadOf(hits, meta);
  const row = src === "picture" ? confirmRowFor(height) : null;
  const fromRef = src === "correction" && ref && finite(ref.cos);
  const list = (ranked?.length ? ranked : (hits || []).map((h) => ({ id: meta?.[h.index]?.id, score: h.score })))
    .filter((r) => r?.id).slice(0, 5).map((r) => [r.id, round3(r.score)]);
  return {
    w: 1,
    src,
    cos: round3(fromRef ? ref.cos : lead.cos),
    lead: round3(fromRef ? ref.cos - (hits?.[0]?.score ?? 0) : lead.lead),
    rival: lead.rival,
    rivalName: lead.rivalName,
    others: othersOf(hits, meta),
    h: Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
    row: row ? { h: row.minHeight, T: row.minSim, G: row.minGap } : null,
    top5: list,
    ref: fromRef ? { id: ref.id ?? null, cos: round3(ref.cos), n: ref.n || 1, ts: ref.ts ?? null, bar: ref.bar ?? null } : null,
    model: tags?.clip ?? null,
    crop: tags?.crop ?? null,
    cat: tags?.catalog ?? null,
  };
}

/** Adds what is only known after the title line was read, and moves the source when a number or set code settled the card. */
export function withVerdicts(why, card) {
  if (!why) return why;
  const title = card?.titleConfirmed ? "agree" : card?.titleContradicts ? "contradict" : "silent";
  const src = card?.numberRead ? "number" : card?.setEvidence === "code" ? "setHint" : why.src;
  return { ...why, src, title, tier: confTier(card?.confidence ?? 0) };
}

/** The same record once the user picked the card themselves: the picture's own numbers stay as "what it alone said". */
export function userWhy(why) {
  return why ? { ...why, src: "user" } : why;
}

const text = (value) => (typeof value === "string" && value ? value.slice(0, MAX_TEXT) : null);
const num = (value) => (finite(value) ? round3(value) : null);

/** A why-record safe to store: only the known keys, enum values checked, text and lists bounded. Null when it is not one. */
export function sanitizeWhy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !WHY_SOURCES.includes(raw.src)) return null;
  const out = { w: 1, src: raw.src };
  for (const key of ["cos", "lead"]) if (num(raw[key]) !== null) out[key] = num(raw[key]);
  if (finite(raw.h)) out.h = Math.round(raw.h);
  if (finite(raw.price)) out.price = Math.round(raw.price * 100) / 100;
  for (const key of ["rival", "rivalName", "model", "cat"]) if (text(raw[key])) out[key] = text(raw[key]);
  if (finite(raw.crop)) out.crop = raw.crop;
  if (TITLES.includes(raw.title)) out.title = raw.title;
  if (TIERS.includes(raw.tier)) out.tier = raw.tier;
  if (Array.isArray(raw.others)) out.others = raw.others.map(text).filter(Boolean).slice(0, 2);
  if (Array.isArray(raw.top5)) {
    out.top5 = raw.top5.filter((r) => Array.isArray(r) && text(r[0]) && finite(r[1])).slice(0, 5).map((r) => [text(r[0]), round3(r[1])]);
  }
  const row = raw.row;
  if (row && finite(row.h) && finite(row.T) && finite(row.G)) out.row = { h: row.h, T: row.T, G: row.G };
  const ref = raw.ref;
  if (ref && finite(ref.cos)) out.ref = { id: text(ref.id), cos: round3(ref.cos), n: finite(ref.n) ? ref.n : 1, ts: finite(ref.ts) ? ref.ts : null, bar: finite(ref.bar) ? ref.bar : null };
  // Keep the record small whatever came in: the lists go first.
  if (JSON.stringify(out).length > MAX_JSON) { delete out.top5; delete out.others; }
  return out;
}
