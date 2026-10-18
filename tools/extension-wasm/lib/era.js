// The era a lot comes from, chosen once by the user.
// At listing-photo size the recognizer gets the Pokémon right but leans toward
// modern printings; among printings of the chosen era it usually ranks the
// true one first (measured on two ShopGoodwill lots, see lessons.md).

export const ERAS = [
  { id: "wotc", label: "1999–2003 · Base Set to e-Card", series: ["base", "gym", "neo", "lc", "ecard"] },
  { id: "ex-dp", label: "2003–2009 · EX, POP, Diamond & Pearl", series: ["ex", "pop", "dp"] },
  { id: "pl-col", label: "2009–2011 · Platinum to Call of Legends", series: ["pl", "hgss", "col"] },
  { id: "bw-xy", label: "2011–2016 · Black & White, XY", series: ["bw", "xy"] },
  { id: "sm-swsh", label: "2017–2022 · Sun & Moon, Sword & Shield", series: ["sm", "swsh"] },
  { id: "sv-me", label: "2023 on · Scarlet & Violet, Mega Evolution", series: ["sv", "me"] },
];

// Set-code prefixes whose letters are not the TCGdex series name.
const SERIES_BY_PREFIX = {
  sve: "sv", svp: "sv", smp: "sm", sma: "sm", det: "sm", swshp: "swsh", cel: "swsh", fut: "swsh",
  bwp: "bw", dv: "bw", xyp: "xy", g: "xy", dc: "xy", np: "pop", dpp: "dp", hgssp: "hgss",
  ru: "pl", si: "neo", basep: "base",
};

const LEAD = 0.04;       // a printing this far ahead inside the era is the one
const NEAR = 0.02;       // otherwise offer every printing this close to the best
const MAX_CHOICES = 4;

export function eraById(id) {
  return ERAS.find((era) => era.id === id) || null;
}

export function seriesOf(card) {
  const fromImage = String(card?.imageUrl || "").split("/")[4];
  if (fromImage) return fromImage;
  const prefix = String(card?.setCode || "").match(/^[a-z]+/i)?.[0]?.toLowerCase() || "";
  return SERIES_BY_PREFIX[prefix] || prefix;
}

export function inEra(card, era) {
  return era.series.includes(seriesOf(card));
}

const _eraRows = new WeakMap();
/** Catalog row indices whose printing is in the era; cached per catalog array. */
export function eraRowIndices(meta, era) {
  let byEra = _eraRows.get(meta);
  if (!byEra) _eraRows.set(meta, (byEra = new Map()));
  if (!byEra.has(era.id)) {
    const out = [];
    meta.forEach((card, index) => { if (card && inEra(card, era)) out.push(index); });
    byEra.set(era.id, out);
  }
  return byEra.get(era.id);
}

/**
 * Same-name printings inside the era, best first, as {index, score}.
 * Returns {pick: index} when one printing is clearly it, {choices: [index…]} when
 * the user should choose, or null when the era has no printing of this card.
 */
export function eraPrintings(scored) {
  if (!scored.length) return null;
  const best = scored[0].score;
  if (scored.length === 1 || best - scored[1].score >= LEAD) return { pick: scored[0].index };
  const choices = scored
    .filter((hit, i) => i < 2 || best - hit.score <= NEAR)
    .slice(0, MAX_CHOICES)
    .map((hit) => hit.index);
  return { choices };
}
