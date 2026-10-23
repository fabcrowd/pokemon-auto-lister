// The "Why this card?" sentence, in plain words, built from a why-record (lib/why.js). Plain text: the popup escapes it.

const two = (value) => Number(value).toFixed(2);

function sourceSentence(why, name) {
  switch (why.src) {
    case "correction": {
      const when = why.ref?.ts ? new Date(why.ref.ts).toISOString().slice(0, 10) : "";
      const agreed = (why.ref?.n || 1) > 1 ? ` You confirmed it ${why.ref.n} times.` : "";
      const bar = why.ref?.bar != null ? ` (needed ${two(why.ref.bar)})` : "";
      return `From your earlier correction${when ? ` on ${when}` : ""}: you said it was ${name || "this card"}. The two pictures match ${two(why.ref?.cos ?? why.cos ?? 0)} similarity${bar}.${agreed}`;
    }
    case "number": return "Settled by the printed number.";
    case "setHint": return "The set was named by the set symbol or the listing.";
    case "stamp": return "The 1st Edition stamp was read.";
    case "promoted": return `Cheap enough${typeof why.price === "number" ? ` ($${two(why.price)})` : ""} that it was accepted without asking.`;
    case "user": return `You chose this. The picture alone said ${name || "another card"} at ${two(why.cos ?? 0)}.`;
    default: {
      const ahead = (why.lead ?? 0) >= 0.02 ? "clearly ahead of the next card" : "close to the next card";
      const size = why.h ? `, ${why.h} px tall` : "";
      const needed = why.row ? ` Needed ${two(why.row.T)} at this size.` : "";
      const title = why.title === "agree" ? " The title line agrees."
        : why.title === "contradict" ? " The title line disagreed, so this was lowered."
          : why.title === "silent" ? " The title line gave no answer." : "";
      return `Matched by picture: ${two(why.cos ?? 0)} similarity, ${ahead}${size}.${needed}${title}`;
    }
  }
}

/** @param {object|null} why @param {{name?: string}} context the card's current name */
export function whyText(why, { name } = {}) {
  if (!why?.src) return "";
  const others = why.others?.length ? ` Closest others: ${why.others.join(", ")}.` : "";
  return sourceSentence(why, name) + others;
}
