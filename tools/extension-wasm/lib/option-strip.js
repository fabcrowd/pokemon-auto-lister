// Image-first pickers for a confirmed row: printings and versions are strips of card thumbnails, finishes are
// chips that carry their price. Pure view models and markup; popup.js wires the taps to the same functions the
// old menus used.

import { formatUsd, versionLabel } from "./card-display.js";
import { escHtml, thumbUrl } from "./card-picker.js";

/** More choices than this fold behind a "More" tile. */
export const STRIP_LIMIT = 8;

/** Prettify grid keys: "1stEditionHolofoil" becomes "1st Ed Holofoil". */
export function formatPrinting(p) {
  const s = String(p);
  if (/^1stEdition/i.test(s)) return "1st Ed " + s.slice(10);
  if (s === "holofoil") return "Holofoil";
  if (s === "normal") return "Normal";
  if (s === "reverseHolofoil") return "Reverse Holo";
  if (s === "unlimitedHolofoil") return "Unlimited Holo";
  return s.replace(/([A-Z])/g, " $1").trim().replace(/^./, (c) => c.toUpperCase());
}

/** First `limit` items, and the rest to keep behind "More". */
export function splitMore(items, limit = STRIP_LIMIT) {
  const list = items || [];
  return list.length > limit ? { shown: list.slice(0, limit), more: list.slice(limit) } : { shown: list, more: [] };
}

/**
 * One tile per printing (same card name, different catalog rows). The printing the user confirmed, or the one a page
 * heading suggested, is checked; a suggestion is also marked so the "?" confirm stays meaningful.
 */
export function setTiles(card) {
  const choices = card?.setChoices || [];
  if (choices.length <= 1) return [];
  const confirmed = card.setConfirmed === true;
  const guessed = Boolean(card.bestGuess) && !confirmed;
  const picked = confirmed || guessed ? card.identity?.id : "";
  return choices.map((c) => {
    const set = c.set || c.setCode || "Unknown set";
    const number = c.number || "";
    const suggested = guessed && c.id === picked;
    const base = [set, number ? `number ${number}` : ""].filter(Boolean).join(" ");
    return {
      id: c.id, name: c.name || "", set, number, art: thumbUrl(c), sub: number ? `#${number}` : "",
      label: suggested ? `Suggested: ${base}` : base, checked: Boolean(picked) && c.id === picked, suggested,
    };
  });
}

/** The version the row shows, then each other version it offered (Pikachu ex beside Pikachu V), each with its own art. */
export function versionTiles(card, conditions = ["NM"]) {
  const versions = card?.versionChoices || [];
  if (!versions.length) return [];
  const own = card.identity || {};
  const tile = (entry, checked, keep) => {
    const parts = versionLabel(entry, conditions).split(" · ");
    const name = entry.name || "";
    const rest = parts[0] === name ? parts.slice(1) : parts;
    return {
      id: entry.id || (keep ? "keep" : ""), name, set: "", number: "", art: thumbUrl(entry), sub: rest.join(" · "),
      label: [name, ...rest].filter(Boolean).join(", "), checked, suggested: false, ...(keep ? { keep: true } : {}),
    };
  };
  return [tile(own, true, true), ...versions.map((v) => tile(v, false, false))];
}

/**
 * One chip per printing/finish of the same art, with the price for the first enabled condition that has one.
 * A single printing has nothing to choose. Glare makes holo and reverse hard to tell apart, so the price is the cue.
 */
export function finishChips(grid, { chosen = "", suggested = "", conditions = ["NM"] } = {}) {
  const keys = Object.keys(grid?.variants || {});
  if (keys.length <= 1) return [];
  const order = conditions?.length ? conditions : ["NM"];
  return keys.map((key) => {
    const found = order.map((cond) => [cond, grid.variants[key]?.conditions?.[cond]]).find(([, v]) => typeof v === "number" && v > 0);
    const label = formatPrinting(key);
    const priceText = found ? formatUsd(found[1]) : "";
    const checked = key === chosen;
    const isSuggested = !checked && key === suggested;
    const aria = `${isSuggested ? "Suggested: " : ""}${found ? `${label}, ${priceText} ${found[0]}` : label}`;
    return { key, label, price: found ? found[1] : null, priceText, condition: found ? found[0] : null, checked, suggested: isSuggested, aria };
  });
}

function tileHtml(tile, { kind, idx, locked, tab }) {
  const first = tile.set || tile.name;
  const art = tile.art ? `<img src="${escHtml(tile.art)}" alt="" loading="lazy" width="63" height="88">` : "";
  const fallback = `<span class="strip-fallback">${escHtml(tile.name)}<br>${escHtml([tile.set, tile.sub].filter(Boolean).join(" "))}</span>`;
  const tag = tile.suggested ? `<span class="pick-guess strip-tag">Suggested</span>` : "";
  const classes = ["strip-tile", tile.checked ? "strip-checked" : "", tile.suggested ? "strip-suggested" : ""].filter(Boolean).join(" ");
  return `<button type="button" class="${classes}" role="radio" aria-checked="${tile.checked}" data-strip-pick="${escHtml(tile.id)}" data-strip-kind="${kind}" data-idx="${idx}" tabindex="${tab ? 0 : -1}" aria-label="${escHtml(tile.label)}" title="${escHtml(tile.label)}"${locked ? ` aria-disabled="true"` : ""}><span class="strip-art${tile.art ? "" : " no-art"}">${art}${fallback}</span>${tag}<span class="pick-name">${escHtml(first)}</span><span class="pick-sub">${escHtml(tile.sub)}</span></button>`;
}

/** A horizontally scrolling radiogroup of thumbnails. Escaped here because the result goes into innerHTML. */
export function renderTileStrip({ kind, idx, label, tiles, expanded = false, locked = false }) {
  const { shown, more } = splitMore(tiles);
  const list = expanded ? tiles : shown;
  const stop = Math.max(0, list.findIndex((tile) => tile.checked));
  const items = list.map((tile, at) => tileHtml(tile, { kind, idx, locked, tab: at === stop })).join("");
  const toggle = more.length
    ? `<button type="button" class="strip-more" data-strip-more="${kind}" data-idx="${idx}" aria-expanded="${expanded}">${expanded ? "Fewer" : `More +${more.length}`}</button>`
    : "";
  return `<div class="strip" role="radiogroup" aria-label="${escHtml(label)}" data-strip="${kind}" data-idx="${idx}">${items}${toggle}</div>`;
}

/** Large one-tap finish chips: the label and, when the grid has one, its price. `confirmMark` is trusted markup. */
export function renderChipGroup({ idx, label, chips, note = "", confirmMark = "" }) {
  const stop = Math.max(0, chips.findIndex((chip) => chip.checked || chip.suggested));
  const items = chips.map((chip, at) => {
    const classes = ["chip", chip.checked ? "chip-checked" : "", chip.suggested ? "chip-suggested" : ""].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" role="radio" aria-checked="${chip.checked}" data-strip-pick="${escHtml(chip.key)}" data-strip-kind="finish" data-idx="${idx}" tabindex="${at === stop ? 0 : -1}" aria-label="${escHtml(chip.aria)}"><span class="chip-label">${escHtml(chip.label)}</span>${chip.priceText ? `<span class="chip-price">${escHtml(chip.priceText)}</span>` : ""}</button>`;
  }).join("");
  const name = note ? `${label}. ${note}` : label;
  return `<div class="chip-wrap"><div class="chips" role="radiogroup" aria-label="${escHtml(name)}" data-strip="finish" data-idx="${idx}"${note ? ` title="${escHtml(note)}"` : ""}>${items}</div>${confirmMark}</div>`;
}
