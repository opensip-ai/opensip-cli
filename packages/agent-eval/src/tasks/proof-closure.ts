import { isUnknownRecord as isRecord } from '../model/value-helpers.js';

import { isCompleteSymbolSearchProjection } from './graph-projection-validation.js';
import { projectJsonManifest } from './native-task-response-extractors.js';

import type { ProofClosureAssessment, ProofClosureAssessor } from '../model/task.js';

function assessment(projectionComplete: boolean, reasonCode: string): ProofClosureAssessment {
  return {
    domainExhausted: projectionComplete,
    projectionComplete,
    reasonCodes: projectionComplete ? [] : [reasonCode],
  };
}

/** Validate a bounded native read before treating its byte projection as a closed domain. */
export const assessNativeReadProofDomain: ProofClosureAssessor = (payload) => {
  const complete =
    isRecord(payload) &&
    typeof payload.content === 'string' &&
    typeof payload.path === 'string' &&
    payload.path.length > 0 &&
    payload.truncated === false;
  return assessment(complete, 'malformed-native-read-projection');
};

/** Require both complete bytes and a lossless JSON manifest projection. */
export const assessJsonManifestProofDomain: ProofClosureAssessor = (payload) => {
  const complete =
    isRecord(payload) && payload.truncated === false && projectJsonManifest(payload) !== undefined;
  return assessment(complete, 'malformed-json-manifest-projection');
};

/** Validate a bounded native path inventory before treating its projection as closed. */
export const assessNativeGlobProofDomain: ProofClosureAssessor = (payload) => {
  const complete =
    isRecord(payload) &&
    Array.isArray(payload.paths) &&
    payload.paths.every((path) => typeof path === 'string' && path.length > 0) &&
    payload.truncated === false;
  return assessment(complete, 'malformed-native-glob-projection');
};

interface ExactSymbolSearchContract {
  readonly filePath?: string;
  readonly query: string;
}

/** Couple exact-search closure to its complete public projection and requested identity. */
export function createExactSymbolSearchProofAssessor(
  contract: ExactSymbolSearchContract,
): ProofClosureAssessor {
  return (payload) => {
    const symbols = isRecord(payload) && isRecord(payload.data) ? payload.data.symbols : undefined;
    const complete =
      isCompleteSymbolSearchProjection(payload) &&
      Array.isArray(symbols) &&
      symbols.every(
        (symbol) =>
          isRecord(symbol) &&
          symbol.simpleName === contract.query &&
          (contract.filePath === undefined || symbol.filePath === contract.filePath),
      );
    return assessment(complete, 'malformed-symbol-projection');
  };
}
