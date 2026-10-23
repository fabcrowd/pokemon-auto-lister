// Small pieces of the popup that speak for memory: the chips on a row and the "Why this card?" panel. Each returns
// HTML with every value escaped, because the popup puts it in innerHTML.

import { escHtml } from "./card-picker.js";
import { whyText } from "./why-text.js";

const times = (n) => (n >= 2 ? ` (x${n})` : "");

/**
 * The chip a row carries for the user's corrections. A row the user just corrected, one confirmed by an earlier
 * correction, or (on a card to choose) one memory boosted or demoted. Community-pack rows are not the user's: no chip.
 */
export function memoryChipHtml(card, { choose = false } = {}) {
  const chip = (text, title) => ` <span class="memory-chip" title="${escHtml(title)}">${escHtml(text)}</span>`;
  const memory = card?.memory && !card.memory.pack ? card.memory : null;
  if (choose) {
    if (!memory) return "";
    return chip(`You corrected this before${times(memory.n || 1)}`, "A card you corrected earlier looks like this one. Its answer is first.");
  }
  if (card?.corrected) {
    const { count = 1, remembered } = card.corrected;
    return remembered
      ? chip(`Corrected, remembered${times(count)}`, "Your correction is saved on this device and used on later scans.")
      : chip("Corrected", "Your correction is saved on this device. Turn on \"Use my corrections\" in settings to use it.");
  }
  if (card?.confirmedBy === "correction" && memory) {
    return chip(`From your correction${times(memory.n || 1)}`, "This card looks like one you corrected before. Wrong card? Search for the right one.");
  }
  return "";
}

/** The mark a pick leaves on the row: the user changed the scanner's answer, or agreed again with a remembered one. */
export function correctedMark(guess, pickedId, response) {
  if (!response) return null;
  const changed = Boolean(pickedId) && pickedId !== guess?.id;
  if (!changed && !response.agreed) return null;
  return { count: response.count || 1, remembered: response.remembered !== false };
}

/** The "Why this card?" button, and under it (when open) the reason in plain words. Empty when there is no why-record. */
export function whyHtml(card, idx, open) {
  if (!card?.why) return "";
  const text = whyText(card.why, { name: card.identity?.name });
  const button = `<button type="button" class="link-btn why-btn" data-why data-idx="${idx}" aria-expanded="${open}" aria-controls="why-${idx}">Why this card?</button>`;
  const panel = open && text ? `<div class="why-pop" id="why-${idx}" role="note">${escHtml(text)}</div>` : "";
  return `<div class="why-row">${button}</div>${panel}`;
}
