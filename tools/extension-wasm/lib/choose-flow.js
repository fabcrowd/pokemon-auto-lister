// Two identification states: CONFIRMED (the match cleared the bar, or the user picked it: a name and a price) and
// CHOOSE (below the bar: the user picks from the closest cards, best one preselected, no name asserted, no price).
// Card backs are neither: they are not cards to identify.

import { isIdentified, needsPrinting } from "./card-display.js";
import { escHtml, thumbUrl } from "./card-picker.js";
import { choiceName } from "./set-choice.js";
import { CLEAR_GAP } from "./fusion.js";

/** 'confirmed' | 'choose' | 'back'. A card the user just picked and is still pricing is already confirmed. */
export function chooseState(card) {
  if (!card || card.cardBack) return "back";
  if (card.pricing === true) return "confirmed";
  return isIdentified(card) ? "confirmed" : "choose";
}

/** What the page overlay's frame and tag show for a card: identified, printing, choose, or none (a card back). */
export function overlayStateOf(card) {
  const state = chooseState(card);
  if (state === "back") return "none";
  if (state === "choose") return "choose";
  return needsPrinting(card) ? "printing" : "identified";
}

/**
 * The photo's own name line agrees with this candidate. Only the title verdict the scan already carries is used:
 * a name the title line spelled that differs from the picture's (titleContradicts), or the picture's name when the
 * title line confirmed it (titleConfirmed) or the row was re-ranked to the name the title spells (titleReranked).
 */
export function nameAgreesWithPhoto(card, candidate) {
  if (!card || !candidate?.name) return false;
  const read = card.titleContradicts || (card.titleConfirmed || card.titleReranked ? card.identity?.name : null);
  return Boolean(read) && choiceName(read) === choiceName(candidate.name);
}

/** One candidate as the popup shows it: art, name, set, number, printing, and the agreement and best marks. */
export function candidateView(card, candidate, { best = false } = {}) {
  const agrees = nameAgreesWithPhoto(card, candidate);
  const printing = typeof candidate?.printing === "string" && candidate.printing ? candidate.printing : null;
  const set = candidate?.set || candidate?.setCode || "";
  const number = candidate?.number || "";
  const label = [
    [candidate?.name, set, number ? `number ${number}` : "", printing].filter(Boolean).join(", "),
    agrees ? "name matches the photo" : "",
    best ? "best match" : "",
  ].filter(Boolean).join(", ");
  return { id: candidate?.id, name: candidate?.name || "", set, number, printing, art: thumbUrl(candidate), agrees, best, label };
}

/** The picture's own name was spelled differently by the title line: this candidate is the name the title rules out. */
function titleContradicted(card, candidate) {
  return Boolean(card?.titleContradicts) && Boolean(card.identity?.name)
    && choiceName(candidate?.name) === choiceName(card.identity.name)
    && choiceName(candidate?.name) !== choiceName(card.titleContradicts);
}

/**
 * The cards offered for a card to choose, the preselected one first: a candidate whose name agrees with the photo,
 * else the closest; one the title contradicts is passed over while another exists. No title evidence changes nothing.
 */
export function candidatesOfCard(card) {
  const list = card?.candidates?.length ? card.candidates : card?.setChoices?.length ? card.setChoices : [];
  if (list.length < 2) return list;
  let at = list.findIndex((candidate) => nameAgreesWithPhoto(card, candidate));
  if (at < 0) at = list.findIndex((candidate) => !titleContradicted(card, candidate));
  return at <= 0 ? list : [list[at], ...list.slice(0, at), ...list.slice(at + 1)];
}

/**
 * The preselected candidate is a clear match: it agrees with the photo's name, or it leads the best candidate with
 * another card name by at least CLEAR_GAP (similarity `score` of the card's `ranked`, `rank` for older rows). Without scores
 * the lead is unknown: not decisive. When every candidate is the same card, only the printing is open: the user's pick.
 */
export function bulkDecisive(card) {
  const [first, ...rest] = candidatesOfCard(card);
  if (!first) return false;
  const rivals = rest.filter((candidate) => choiceName(candidate.name) !== choiceName(first.name));
  if (!rivals.length) return false;
  if (nameAgreesWithPhoto(card, first)) return true;
  const scores = new Map((card.ranked || []).map((row) => [row.id, row.score ?? row.rank]));
  const own = scores.get(first.id);
  if (!Number.isFinite(own) || rivals.some((candidate) => !Number.isFinite(scores.get(candidate.id)))) return false;
  return own - Math.max(...rivals.map((candidate) => scores.get(candidate.id))) >= CLEAR_GAP;
}

/** Indexes of the cards waiting for the user's choice. */
export function chooseIndexes(cards) {
  const out = [];
  (cards || []).forEach((card, idx) => { if (chooseState(card) === "choose") out.push(idx); });
  return out;
}

/** Each card to choose that has a candidate, paired with its preselected (best) one and whether that one is decisive. */
export function bulkPairs(cards) {
  return chooseIndexes(cards)
    .map((idx) => ({ idx, candidate: candidatesOfCard(cards[idx])[0], decisive: bulkDecisive(cards[idx]) }))
    .filter((pair) => pair.candidate?.id);
}

export const chooseHeading = (count) => `To confirm (${count})`;
export const confirmLabel = (count) => `Confirm ${count}`;
/** The bulk panel's all-or-none toggle: it offers to tick everything until everything is ticked. */
export const tickAllLabel = (allTicked) => (allTicked ? "Untick all" : "Tick all");

/** The candidate buttons for one card to choose (already-escaped HTML): the first is preselected as the best match. */
export function renderCandidateCards(card, idx) {
  return candidatesOfCard(card).map((candidate, at) => {
    const view = candidateView(card, candidate, { best: at === 0 });
    const art = view.art
      ? `<img src="${escHtml(view.art)}" alt="" loading="lazy" width="63" height="88">`
      : `<span class="pick-blank" aria-hidden="true"></span>`;
    const sub = [view.set, view.number ? `#${view.number}` : ""].filter(Boolean).join(" ");
    const marks = `${view.best ? `<span class="pick-best">Best match</span>` : ""}${view.agrees ? `<span class="pick-agree" title="The name on the card matches">&#10003; name</span>` : ""}`;
    return `<button type="button" class="pick-card pick-choice${view.best ? " pick-best-card" : ""}" data-pick="${escHtml(view.id)}" data-idx="${idx}" aria-label="${escHtml(`${view.label}. Confirm this card`)}" title="${escHtml(view.label)}">${art}${marks}<span class="pick-name">${escHtml(view.name)}</span><span class="pick-sub">${escHtml(sub)}</span>${view.printing ? `<span class="pick-sub">${escHtml(view.printing)}</span>` : ""}</button>`;
  }).join("");
}

/** The "To confirm (N)" group: one disclosure over the rows (already-escaped HTML), and the bulk review button. */
export function renderChooseGroup(rowsHtml, count, expanded, reviewCount = 0) {
  if (!count) return "";
  return `<section class="choose-group" aria-labelledby="choose-heading">
    <div class="choose-head">
      <button type="button" class="choose-toggle" id="choose-heading" data-choose-toggle aria-expanded="${expanded}" aria-controls="choose-list">${escHtml(chooseHeading(count))}</button>
      ${reviewCount ? `<button type="button" class="choose-review" data-review-all>Review all ${reviewCount}</button>` : ""}
    </div>
    <div id="choose-list" class="choose-list"${expanded ? "" : " hidden"}>${rowsHtml}</div>
  </section>`;
}
