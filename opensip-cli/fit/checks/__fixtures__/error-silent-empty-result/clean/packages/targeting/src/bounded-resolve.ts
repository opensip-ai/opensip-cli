/**
 * CLEAN fixture — the reviewer-REJECTED `||` family, verbatim in shape from
 * `packages/targeting/src/bounded-resolve.ts` (lines 191 / 249) and
 * `packages/graph/graph-java/src/walk.ts` / `graph-rust/src/walk-helpers.ts`.
 *
 * `capped: resultLimitReached || walk.capped` and
 * `inTestFile: frame.inTestScope || ctx.fileInTestFile` are boolean merges of
 * already-computed outcome flags — not fallbacks, not failure paths, no
 * defaulting. Two independent human reviewers rejected every one of these as a
 * detector false positive; this check must never fire on them (it never looks
 * at `||` at all).
 *
 * Also includes the reviewer-accepted empty-INPUT path: nothing failed, there
 * was genuinely nothing to walk, and the honest answer is an empty result.
 *
 * Expected: ZERO findings.
 */
interface Resolution {
  readonly files: readonly string[];
  readonly capped: boolean;
  readonly cancelled: boolean;
}

interface WalkOutcome {
  readonly files: string[];
  readonly capped: boolean;
}

declare function walkTree(roots: readonly string[], limit: number): WalkOutcome;

export function resolveTargetsBounded(roots: readonly string[], limit: number): Resolution {
  // Legitimate empty-INPUT path — no failure occurred.
  if (roots.length === 0) {
    return { files: [], capped: false, cancelled: false };
  }

  const walk = walkTree(roots, limit);
  const resultLimitReached = walk.files.length >= limit;

  return {
    files: walk.files,
    capped: resultLimitReached || walk.capped,
    cancelled: false,
  };
}

export function classifyOccurrence(
  frameInTestScope: boolean,
  fileInTestFile: boolean,
  hasTestAttribute: boolean,
): { readonly inTestFile: boolean } {
  return { inTestFile: frameInTestScope || fileInTestFile || hasTestAttribute };
}
