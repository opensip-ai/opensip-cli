/**
 * Exact duplicate-body detection — the single implementation of the policy that
 * graph's `duplicated-function-body` rule and yagni's duplicate detector both consume
 * (ADR-0064). Pure over `CloneCandidate[]`; emits tool-agnostic findings (no `Signal`).
 *
 * Two complementary paths under one result:
 *   1. Per-instance (size-gated): groups of ≥2 byte-identical normalized bodies that
 *      pass a line floor (default 5) AND a normalized-char floor (default 200) — the
 *      char floor drops thin wrappers (`defineCheck`/pass-through) that share a body
 *      but are never an extract target. The caller emits N-1 per group.
 *   2. Aggregate (cross-package): a body hash present in ≥ `minCrossPackagePackages`
 *      (default 3) DISTINCT packages emits ONE aggregate and SUPPRESSES its
 *      per-instance signals (a lighter body-size-only floor, default 80, no line floor).
 *
 * The hash already normalizes whitespace + strips comments (see `digestCanonicalBody`),
 * so identical hashes mean identical executable bodies.
 */

import type {
  CloneCandidate,
  CrossPackageAggregate,
  DupOpts,
  DuplicateFindings,
  DuplicateGroup,
} from './types.js';

const DEFAULT_MIN_LINES = 5;
const DEFAULT_MIN_BODY_SIZE = 200;
const DEFAULT_MIN_CROSS_PACKAGE_PACKAGES = 3;
// Lighter than DEFAULT_MIN_BODY_SIZE (the per-instance floor) and applied with NO line
// floor: the aggregate path catches genuinely-small shared utilities copied across
// packages, so its floor only drops trivial bodies (empty DI shims, one-line getters).
const DEFAULT_MIN_CROSS_PACKAGE_BODY_SIZE = 80;

/**
 * Detect exact duplicate function bodies. Returns cross-package aggregates plus the
 * per-instance groups that survive aggregate suppression. The caller wraps each into
 * its own signal/metadata.
 */
export function findDuplicateBodies(
  candidates: readonly CloneCandidate[],
  opts: DupOpts = {},
): DuplicateFindings {
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;
  const minBodySize = opts.minBodySize ?? DEFAULT_MIN_BODY_SIZE;
  const minPackages = opts.minCrossPackagePackages ?? DEFAULT_MIN_CROSS_PACKAGE_PACKAGES;
  const minCrossPackageBodySize = opts.minCrossPackageBodySize ?? DEFAULT_MIN_CROSS_PACKAGE_BODY_SIZE;

  // Aggregate path first: group every kind/test-eligible candidate by body hash (no
  // line floor) so we can detect cross-package spread and decide which hashes to
  // suppress on the per-instance path below.
  const aggregateBuckets = groupByHashUnfloored(candidates);
  const suppressedHashes = new Set<string>();
  const aggregates: CrossPackageAggregate[] = [];

  for (const [bodyHash, occs] of aggregateBuckets) {
    const packages = [...new Set(occs.map((o) => o.package ?? ''))].sort();
    if (packages.length < minPackages) continue;
    const anchor = lowestByQualifiedName(occs);
    // Lighter, body-size-only floor (NO line floor) — see DEFAULT_MIN_CROSS_PACKAGE_BODY_SIZE.
    // A body that fails this won't surface on the per-instance path either (200-char
    // floor is stricter), so there is nothing to suppress.
    if (anchor.bodySize !== undefined && anchor.bodySize < minCrossPackageBodySize) continue;
    suppressedHashes.add(bodyHash);
    aggregates.push({ bodyHash, anchor, packages, occurrenceCount: occs.length });
  }

  // Per-instance path: size-gated groups, skipping any hash already claimed by an
  // aggregate (no double-reporting).
  const rawGroups = groupByHash(candidates, minLines, minBodySize);
  const groups: DuplicateGroup[] = [];
  for (const group of rawGroups) {
    if (group.length < 2) continue;
    const primary = group[0];
    /* v8 ignore next */
    if (!primary) continue;
    if (suppressedHashes.has(primary.bodyHash)) continue;
    groups.push({ bodyHash: primary.bodyHash, members: group });
  }

  return { aggregates, groups };
}

/**
 * A function's stable physical identity: where it is declared. A producer's index can
 * surface the same physical function more than once (dual simple/qualified indexing,
 * recursive self-reference); two entries sharing this identity are the SAME function and
 * must never count as a duplicate of each other.
 */
function identityOf(occ: CloneCandidate): string {
  return `${occ.filePath}:${String(occ.line)}:${String(occ.column)}:${occ.simpleName}`;
}

/**
 * Add a candidate to its body-hash bucket, deduping by physical identity so a function
 * never appears twice in its own bucket (which would form a phantom 2-member group and
 * self-report as a duplicate).
 */
function pushDeduped(
  buckets: Map<string, CloneCandidate[]>,
  seenByHash: Map<string, Set<string>>,
  occ: CloneCandidate,
): void {
  let bucket = buckets.get(occ.bodyHash);
  let seen = seenByHash.get(occ.bodyHash);
  if (!bucket) {
    bucket = [];
    buckets.set(occ.bodyHash, bucket);
    seen = new Set<string>();
    seenByHash.set(occ.bodyHash, seen);
  }
  /* v8 ignore next */
  if (!seen) return;
  const id = identityOf(occ);
  if (seen.has(id)) return;
  seen.add(id);
  bucket.push(occ);
}

function groupByHash(
  candidates: readonly CloneCandidate[],
  minLines: number,
  minBodySize: number,
): readonly (readonly CloneCandidate[])[] {
  const buckets = new Map<string, CloneCandidate[]>();
  const seenByHash = new Map<string, Set<string>>();
  for (const occ of candidates) {
    if (!isInterestingForDup(occ, minLines, minBodySize)) continue;
    pushDeduped(buckets, seenByHash, occ);
  }
  return [...buckets.values()];
}

/**
 * Group candidates by body hash applying ONLY the kind/test-file exclusions (no
 * size/line floor) — the grouping the aggregate cross-package path consumes. Returns a
 * Map so callers keep the body-hash key for suppression bookkeeping.
 */
function groupByHashUnfloored(
  candidates: readonly CloneCandidate[],
): ReadonlyMap<string, CloneCandidate[]> {
  const buckets = new Map<string, CloneCandidate[]>();
  const seenByHash = new Map<string, Set<string>>();
  for (const occ of candidates) {
    if (!isEligibleKind(occ)) continue;
    pushDeduped(buckets, seenByHash, occ);
  }
  return buckets;
}

function lowestByQualifiedName(occs: readonly CloneCandidate[]): CloneCandidate {
  return occs.reduce((lo, c) => (c.qualifiedName < lo.qualifiedName ? c : lo));
}

/**
 * The kind/test-file exclusions shared by both code paths. Inline arrows / function
 * expressions / module-init occurrences are never an extract/hoist target; test-file
 * occurrences are excluded on both paths.
 */
export function isEligibleKind(occ: CloneCandidate): boolean {
  if (occ.kind === 'arrow' || occ.kind === 'function-expression' || occ.kind === 'module-init') {
    return false;
  }
  if (occ.inTestFile) return false;
  return true;
}

/**
 * The per-instance dup-body filter: the shared kind/test exclusions plus the size/line
 * floor. Candidates lacking `bodySize` skip the size check ("passes"). `bodyLines` is the
 * canonical span the caller pre-resolves; absent ⇒ `endLine − line + 1` fallback.
 */
function isInterestingForDup(occ: CloneCandidate, minLines: number, minBodySize: number): boolean {
  if (!isEligibleKind(occ)) return false;
  const span = occ.bodyLines ?? occ.endLine - occ.line + 1;
  if (span < minLines) return false;
  if (occ.bodySize !== undefined && occ.bodySize < minBodySize) return false;
  return true;
}
