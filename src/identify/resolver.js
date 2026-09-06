import { normalize, normalizeNumber } from '../collectr/match.js';
import {
  POKEGRADE_SOURCE,
  VELLUM_SOURCE,
  asIdentifyResult,
} from './types.js';
import {
  QuotaExhaustedPokegradeError,
  RetryablePokegradeError,
} from '../pokegrade/client.js';

/**
 * Compare key: prefer setCode|number, else name|set|number.
 * @param {{ name?: string|null, set?: string|null, setCode?: string|null, number?: string|null }} identity
 */
export function identityCompareKey(identity) {
  if (!identity) {
    return '';
  }
  const number = normalizeNumber(identity.number);
  const setCode = normalize(identity.setCode);
  if (setCode && number) {
    return `${setCode}|${number}`;
  }
  const name = normalize(identity.name);
  const set = normalize(identity.set);
  if (name && number) {
    return `${name}|${set}|${number}`;
  }
  if (name && set) {
    return `${name}|${set}`;
  }
  return name || number || '';
}

function identitiesAgree(a, b) {
  const keyA = identityCompareKey(a);
  const keyB = identityCompareKey(b);
  return Boolean(keyA && keyB && keyA === keyB);
}

function vellumAccepted(result) {
  if (!result || result.abstain) {
    return false;
  }
  if (!result.identity) {
    return false;
  }
  const conf = result.confidence;
  if (conf === 'low') {
    return false;
  }
  return true;
}

/**
 * Dual / solo identity resolver (PokeGrade + VellumAI).
 *
 * @param {{
 *   pokegradeClient?: { evaluateFrontImage: Function },
 *   vellumClient?: { evaluateFrontImage: Function },
 *   circuit?: { isOpen: Function, open: Function },
 *   mode?: string,
 *   vellumEnabled?: boolean,
 * }} [options]
 */
export function createIdentityResolver({
  pokegradeClient,
  vellumClient = null,
  circuit = null,
  mode = process.env.IDENTITY_MODE || 'dual',
  vellumEnabled = String(process.env.VELLUM_AI_ENABLED || 'false').toLowerCase() === 'true',
} = {}) {
  const resolvedMode = ['dual', 'local-only', 'pokegrade-only'].includes(mode) ? mode : 'dual';

  /**
   * @param {string} imagePath
   * @param {{ backImagePath?: string|null }} [options]
   */
  async function evaluateFrontImage(imagePath, { backImagePath = null } = {}) {
    const circuitOpen = Boolean(circuit?.isOpen?.());
    let effectiveMode = resolvedMode;
    if (circuitOpen && effectiveMode === 'dual') {
      effectiveMode = 'local-only';
    }
    if (!vellumEnabled && effectiveMode === 'local-only') {
      return {
        mode: effectiveMode,
        identity: null,
        pokegrade: null,
        vellum: null,
        identities: {},
        identityConflict: false,
        localAbstained: true,
        pokegradeSkipped: true,
        reason: 'VellumAI required for solo mode but VELLUM_AI_ENABLED is false',
      };
    }

    const runPokegrade = effectiveMode !== 'local-only' && pokegradeClient;
    const runVellum =
      vellumEnabled &&
      vellumClient &&
      (effectiveMode === 'dual' || effectiveMode === 'local-only');

    let pokegrade = null;
    let vellum = null;
    let pokegradeSkipped = !runPokegrade;
    let retryable = null;

    const tasks = [];

    if (runPokegrade) {
      tasks.push(
        (async () => {
          try {
            const raw = await pokegradeClient.evaluateFrontImage(imagePath, { backImagePath });
            pokegrade = asIdentifyResult(POKEGRADE_SOURCE, raw);
          } catch (err) {
            if (err instanceof QuotaExhaustedPokegradeError) {
              circuit?.open?.(err.message || 'quota');
              pokegradeSkipped = true;
              if (vellumEnabled && vellumClient && effectiveMode === 'dual') {
                effectiveMode = 'local-only';
              }
              return;
            }
            if (err instanceof RetryablePokegradeError) {
              retryable = err;
              return;
            }
            throw err;
          }
        })(),
      );
    }

    if (runVellum) {
      tasks.push(
        (async () => {
          try {
            const raw = await vellumClient.evaluateFrontImage(imagePath, { backImagePath });
            vellum = asIdentifyResult(VELLUM_SOURCE, raw);
          } catch (err) {
            vellum = asIdentifyResult(VELLUM_SOURCE, {
              identity: null,
              abstain: true,
              reason: err.message || 'vellum-error',
              confidence: 'low',
            });
          }
        })(),
      );
    }

    await Promise.all(tasks);

    if (retryable && !vellumAccepted(vellum)) {
      throw retryable;
    }

    // Quota flipped dual→solo mid-flight: ensure Vellum ran
    if (
      pokegradeSkipped &&
      !vellum &&
      vellumEnabled &&
      vellumClient &&
      (resolvedMode === 'dual' || effectiveMode === 'local-only')
    ) {
      try {
        const raw = await vellumClient.evaluateFrontImage(imagePath, { backImagePath });
        vellum = asIdentifyResult(VELLUM_SOURCE, raw);
      } catch (err) {
        vellum = asIdentifyResult(VELLUM_SOURCE, {
          identity: null,
          abstain: true,
          reason: err.message || 'vellum-error',
          confidence: 'low',
        });
      }
      effectiveMode = 'local-only';
    }

    const identities = {
      pokegrade: pokegrade?.identity ?? null,
      vellum: vellum?.identity ?? null,
    };

    if (effectiveMode === 'pokegrade-only' || (!runVellum && pokegrade)) {
      if (!pokegrade?.identity) {
        return {
          mode: effectiveMode,
          identity: null,
          pokegrade,
          vellum,
          identities,
          identityConflict: false,
          localAbstained: false,
          pokegradeSkipped,
          reason: 'PokeGrade did not return an identity',
        };
      }
      return {
        mode: effectiveMode,
        identity: pokegrade.identity,
        pokegrade,
        vellum,
        identities,
        identityConflict: false,
        localAbstained: false,
        pokegradeSkipped,
        reason: null,
      };
    }

    if (effectiveMode === 'local-only' || pokegradeSkipped) {
      const accepted = vellumAccepted(vellum);
      return {
        mode: 'local-only',
        identity: accepted ? vellum.identity : null,
        pokegrade: null,
        vellum,
        identities: { vellum: vellum?.identity ?? null },
        identityConflict: false,
        localAbstained: !accepted,
        pokegradeSkipped: true,
        reason: accepted ? 'vellum-ai-solo' : vellum?.reason || 'VellumAI abstained',
      };
    }

    // Dual
    const bothPresent =
      pokegrade?.identity && vellumAccepted(vellum) && vellum?.identity;
    const conflict = Boolean(bothPresent && !identitiesAgree(pokegrade.identity, vellum.identity));
    const localAbstained = Boolean(runVellum && !vellumAccepted(vellum));

    let identity = pokegrade?.identity ?? null;
    let reason = null;
    if (conflict) {
      reason = 'identity sources disagree';
    } else if (!identity && vellumAccepted(vellum)) {
      identity = vellum.identity;
      reason = 'vellum-ai-fallback';
    } else if (!identity) {
      reason = 'no identity from PokeGrade or VellumAI';
    }

    return {
      mode: 'dual',
      identity,
      pokegrade,
      vellum,
      identities,
      identityConflict: conflict,
      localAbstained,
      pokegradeSkipped: false,
      reason,
    };
  }

  return { evaluateFrontImage, mode: resolvedMode };
}
