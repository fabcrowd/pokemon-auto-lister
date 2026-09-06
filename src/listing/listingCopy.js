/**
 * Build Mercari/eBay listing title and description from card identity + config.
 */

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 1000;

/**
 * @param {object} card
 * @returns {{ name?: string, number?: string, set?: string, rarity?: string }}
 */
export function resolveIdentity(card) {
  const identity = card?.pricedCache?.identity ?? card?.identity ?? {};
  return {
    name: identity.name || undefined,
    number: identity.number || undefined,
    set: identity.set || undefined,
    rarity: identity.rarity || undefined,
  };
}

/**
 * @param {string} template
 * @param {Record<string, string | undefined>} vars
 * @returns {string}
 */
export function applyTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {object} card
 * @param {object} [config]
 * @returns {string}
 */
export function buildListingTitle(card, config = {}) {
  if (typeof card?.title === 'string' && card.title.trim()) {
    return card.title.trim().slice(0, TITLE_MAX);
  }
  const id = resolveIdentity(card);
  const parts = [id.name, id.number, id.set, id.rarity].filter(Boolean);
  const title = parts.join(' ') || config.fallbackTitle || 'Pokemon Card';
  return title.slice(0, TITLE_MAX);
}

/**
 * @param {object} card
 * @param {object} [config]
 * @returns {string}
 */
export function buildListingDescription(card, config = {}) {
  if (typeof card?.description === 'string' && card.description.trim()) {
    return card.description.trim().slice(0, DESCRIPTION_MAX);
  }
  const id = resolveIdentity(card);
  const template =
    config.descriptionTemplate ||
    [
      '{{name}} {{number}} — {{set}}',
      '',
      'Authentic Pokémon TCG single in near-mint / like-new condition.',
      'Ships sleeved and in a top loader from a smoke-free home.',
      'Ships next business day with tracking.',
    ].join('\n');
  return applyTemplate(template, id).slice(0, DESCRIPTION_MAX);
}

/**
 * @param {object} card
 * @param {object} [config]
 * @returns {{ title: string, description: string }}
 */
export function buildListingCopy(card, config = {}) {
  return {
    title: buildListingTitle(card, config),
    description: buildListingDescription(card, config),
  };
}
