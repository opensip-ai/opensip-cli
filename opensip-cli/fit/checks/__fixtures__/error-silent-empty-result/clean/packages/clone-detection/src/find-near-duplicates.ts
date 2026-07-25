/**
 * CLEAN fixture — completeness DERIVED, plus the legitimate empty-input path.
 *
 * Shapes taken from real, correct code in this repo:
 *   - `packages/graph/engine/src/read/bounded-view.ts` — `makeFacet` computes
 *     `complete: values.length === 0`; completeness is never hand-asserted.
 *   - `packages/clone-detection/src/find-near-duplicates.ts` — `if
 *     (eligible.length < 2) return emptyResult();` is honest: nothing failed,
 *     there was genuinely nothing to cluster. Its contract-violation branch
 *     THROWS rather than returning a `complete: true` empty result.
 *
 * Expected: ZERO findings.
 */
interface CoverageFacet {
  readonly requested: boolean;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}

interface NearDuplicateResult {
  readonly clusters: readonly string[];
  readonly coverage: CoverageFacet;
}

declare function collectEligible(candidates: readonly string[]): string[];
declare function buildClusters(eligible: readonly string[]): {
  clusters: string[];
  cappedBuckets: number;
};

export function makeFacet(requested: boolean, reasons: ReadonlySet<string>): CoverageFacet {
  const values = [...reasons].sort();
  return {
    requested,
    complete: values.length === 0,
    truncated: values.some((code) => code.endsWith('-cap')),
    reasons: values,
  };
}

function emptyResult(): NearDuplicateResult {
  return { clusters: [], coverage: makeFacet(true, new Set()) };
}

export function findNearDuplicates(
  candidates: readonly string[],
  lshBands: number,
): NearDuplicateResult {
  if (!Number.isInteger(128 / lshBands)) {
    // A contract violation THROWS — silently returning an empty `complete: true`
    // result would be indistinguishable from "ran clean".
    throw new Error(`findNearDuplicates: invalid lshBands (${String(lshBands)})`);
  }

  const eligible = collectEligible(candidates);
  if (eligible.length < 2) return emptyResult();

  const built = buildClusters(eligible);
  const reasons = new Set(built.cappedBuckets === 0 ? [] : ['lsh-bucket-cap']);
  return { clusters: built.clusters, coverage: makeFacet(true, reasons) };
}
