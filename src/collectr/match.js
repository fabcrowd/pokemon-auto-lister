/**
 * Shared identity normalization helpers for Collectr CSV lookups.
 */

export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeNumber(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^0+/, '');
}

/**
 * Build lookup keys for a card identity (name / set / number).
 * @param {{ name?: string, set?: string, number?: string }} identity
 */
export function identityKeys(identity = {}) {
  const name = normalize(identity.name);
  const set = normalize(identity.set);
  const number = normalizeNumber(identity.number);
  return {
    name,
    set,
    number,
    exact: `${name}|${set}|${number}`,
    nameNumber: `${name}|${number}`,
    nameSet: `${name}|${set}`,
  };
}
