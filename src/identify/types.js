/**
 * Shared identity-source contract for PokeGrade + VellumAI.
 */

/**
 * @typedef {{
 *   name?: string|null,
 *   set?: string|null,
 *   setCode?: string|null,
 *   number?: string|null,
 *   productId?: string|null,
 *   game?: string|null,
 * }} CardIdentity
 */

/**
 * @typedef {{
 *   source: string,
 *   identity: CardIdentity|null,
 *   value?: number|null,
 *   confidence?: string|number|null,
 *   finish?: string|null,
 *   candidates?: Array<object>,
 *   abstain?: boolean,
 *   reason?: string|null,
 *   grading?: object|null,
 *   raw?: unknown,
 * }} IdentifyResult
 */

/**
 * @typedef {{
 *   mode: 'dual'|'local-only'|'pokegrade-only',
 *   identity: CardIdentity|null,
 *   pokegrade: IdentifyResult|null,
 *   vellum: IdentifyResult|null,
 *   identities: { pokegrade?: CardIdentity|null, vellum?: CardIdentity|null },
 *   identityConflict: boolean,
 *   localAbstained: boolean,
 *   pokegradeSkipped: boolean,
 *   reason?: string|null,
 * }} ResolveResult
 */

export const VELLUM_SOURCE = 'vellum-ai';
export const POKEGRADE_SOURCE = 'pokegrade';

/**
 * Normalize a source result onto the shared contract.
 * @param {string} source
 * @param {object|null|undefined} result
 * @returns {IdentifyResult|null}
 */
export function asIdentifyResult(source, result) {
  if (!result) {
    return null;
  }
  return {
    source,
    identity: result.identity ?? null,
    value: result.value ?? null,
    confidence: result.confidence ?? null,
    finish: result.finish ?? null,
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    abstain: Boolean(result.abstain),
    reason: result.reason ?? null,
    grading: result.grading ?? null,
    raw: result.raw ?? result,
  };
}
