// Which printings of a recognized card the user should choose between.
// At listing-photo size the recognizer scores different sets of the same
// Pokémon within a few hundredths of each other, so its top pick is a guess.

const NEAR = 0.03;
const MAX_CHOICES = 4;

// "Vibrava δ" and "Vibrava" are the same name for choosing a set.
// "Mew ex" stays different from "Mew": it is another card.
export function choiceName(name) {
  return String(name || "").replace(/\s*[δ★☆]$/u, "").trim().toLowerCase();
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
