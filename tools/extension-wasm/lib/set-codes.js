// Set codes printed on the card face, which only Scarlet & Violet onward carry (older promos print their own prefix in the number).
// The catalog has no printed code, so the table maps each one to the catalog set it names.
const PRINTED = {
  SVI: ["sv01"], PAL: ["sv02"], OBF: ["sv03"], MEW: ["sv03.5"], PAR: ["sv04"], PAF: ["sv04.5"],
  TEF: ["sv05"], TWM: ["sv06"], SFA: ["sv06.5"], SCR: ["sv07"], SSP: ["sv08"], PRE: ["sv08.5"],
  JTT: ["sv09"], DRI: ["sv10"], BLK: ["sv10.5b"], WHT: ["sv10.5w"],
  MEG: ["me01"], PFL: ["me02"], ASC: ["me02.5"], POR: ["me03"],
  SVE: ["sve"], SVP: ["svp"], MEE: ["mee"], MEP: ["mep"],
};

/** Catalog set codes a printed code names, or [] for anything that is not a printed set code. */
export function catalogSetsForCode(code) {
  return PRINTED[String(code || "").toUpperCase()] || [];
}

export function isPrintedCode(code) {
  return Object.hasOwn(PRINTED, String(code || "").toUpperCase());
}
