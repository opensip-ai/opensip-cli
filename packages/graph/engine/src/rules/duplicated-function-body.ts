/**
 * graph:duplicated-function-body — group catalog entries whose body
 * normalizes to the same hash and report duplicate bodies. The rule has
 * two complementary code paths under one slug:
 *
 *   1. **Per-instance (size-gated).** A "duplicate" is two or more
 *      functions whose normalized body is byte-identical
 *      (whitespace/comment normalization handled by hashFunctionBody).
 *      Two thresholds filter out non-actionable hits:
 *
 *        - minDuplicateBodyLines (default 5): the source span must be at
 *          least this many lines.
 *        - minDuplicateBodySize  (default 200): the *normalized* body
 *          (post comment-strip + whitespace-collapse) must be at least
 *          this many characters. This catches the common case of a
 *          `defineCheck({ ... analyze(content) { return analyzeFile(...) } })`
 *          wrapper where the source spans 8+ lines but the executable
 *          body is only ~80 characters once normalized — structurally
 *          identical to every other thin wrapper, but never an actionable
 *          refactor target.
 *
 *      Emits N-1 signals per group (one per non-primary occurrence).
 *
 *   2. **Aggregate (cross-package).** For each body hash present in
 *      ≥ minCrossPackageDuplicatePackages (default 3) DISTINCT packages
 *      (via `pkgOf`), the rule emits ONE aggregate signal naming the
 *      packages and SUPPRESSES the per-instance signals for that same hash
 *      (no double-reporting). Bodies that don't reach N packages flow
 *      through path (1) unchanged.
 *
 *      This path applies a LIGHTER, body-size-only floor
 *      (`minCrossPackageDuplicateBodySize`, default 80 chars — no line floor)
 *      rather than the per-instance floor: a *small* body copied across
 *      packages is exactly what this path exists to catch, so the floor is
 *      tuned only to drop TRIVIAL bodies (empty DI-constructor shims,
 *      one-line getters, thin delegators) that are never consolidation
 *      targets, while keeping genuinely-small shared utilities visible.
 */

import { createSignal } from '@opensip-tools/core';

import { pkgOf } from '../resolve-callee.js';

import { applySeverityOverride } from './_severity-override.js';
import { defineRule } from './define-rule.js';

import type { Catalog, FeatureTable, FunctionOccurrence, GraphConfig } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const DEFAULT_MIN_LINES = 5;
const DEFAULT_MIN_BODY_SIZE = 200;
const DEFAULT_MIN_CROSS_PACKAGE_PACKAGES = 3;
// Lighter than DEFAULT_MIN_BODY_SIZE (the per-instance floor) and applied with
// NO line floor: the aggregate path is meant to catch genuinely-small shared
// utilities copied across packages, so its floor only drops trivial bodies
// (empty DI shims, one-line getters/delegators).
const DEFAULT_MIN_CROSS_PACKAGE_BODY_SIZE = 80;
const SLUG = 'graph:duplicated-function-body';

export const duplicatedFunctionBodyRule = defineRule({
  slug: SLUG,
  defaultSeverity: 'warning',
  featureDeps: ['bodyLines'],
  evaluate({ catalog, config, features }): readonly Signal[] {
    const minLines = config.minDuplicateBodyLines ?? DEFAULT_MIN_LINES;
    const minBodySize = config.minDuplicateBodySize ?? DEFAULT_MIN_BODY_SIZE;
    const minPackages =
      config.minCrossPackageDuplicatePackages ?? DEFAULT_MIN_CROSS_PACKAGE_PACKAGES;
    const minCrossPackageBodySize =
      config.minCrossPackageDuplicateBodySize ?? DEFAULT_MIN_CROSS_PACKAGE_BODY_SIZE;

    const signals: Signal[] = [];

    // Aggregate path first: group every kind/test-eligible occurrence by
    // body hash (no line floor) so we can detect cross-package spread and
    // decide which hashes to suppress on the per-instance path below.
    const aggregateBuckets = groupByHashUnfloored(catalog);
    const suppressedHashes = new Set<string>();

    for (const [bodyHash, occs] of aggregateBuckets) {
      const packages = [...new Set(occs.map((o) => pkgOf(o)))].sort();
      if (packages.length < minPackages) continue;
      const anchor = lowestByQualifiedName(occs);
      // Lighter, body-size-only floor (NO line floor): keeps the aggregate
      // path catching genuinely-small shared utilities copied across packages,
      // while dropping trivial bodies — empty DI-constructor shims, one-line
      // getters, thin delegators — that are not consolidation targets. A body
      // that fails this won't surface on the per-instance path either (its
      // 200-char floor is stricter), so there is nothing to suppress.
      if (anchor.bodySize !== undefined && anchor.bodySize < minCrossPackageBodySize) continue;
      // This hash is owned by the aggregate path; suppress its per-instance
      // signals so a single duplicate group never double-reports.
      suppressedHashes.add(bodyHash);
      signals.push(
        createSignal({
          source: 'graph',
          severity: applySeverityOverride('low', SLUG, config),
          category: 'quality',
          ruleId: SLUG,
          message: `This body is duplicated across ${String(packages.length)} packages (${packages.join(', ')}) in ${String(occs.length)} occurrences — hoist it into a shared package.`,
          code: { file: anchor.filePath, line: anchor.line, column: anchor.column },
          suggestion:
            'Hoist the shared body into a single shared package and have every copy import it.',
          metadata: {
            packages,
            packageCount: packages.length,
            occurrenceCount: occs.length,
            bodyHash,
          },
        }),
      );
    }

    // Per-instance path: size-gated groups, skipping any hash already
    // claimed by an aggregate signal so a group never double-reports.
    const groups = groupByHash(catalog, minLines, minBodySize, features);
    signals.push(...emitPerInstanceSignals(groups, suppressedHashes, config));
    return signals;
  },
});

/**
 * Per-instance duplicate signals: N-1 per size-gated group, skipping any hash
 * already claimed by an aggregate signal (no double-reporting). Extracted from
 * evaluate() to keep its cognitive complexity within budget.
 */
function emitPerInstanceSignals(
  groups: readonly (readonly FunctionOccurrence[])[],
  suppressedHashes: ReadonlySet<string>,
  config: GraphConfig,
): Signal[] {
  const signals: Signal[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const primary = group[0];
    /* v8 ignore next */
    if (!primary) continue;
    if (suppressedHashes.has(primary.bodyHash)) continue;
    for (let i = 1; i < group.length; i++) {
      const occ = group[i];
      /* v8 ignore next */
      if (!occ) continue;
      signals.push(
        createSignal({
          source: 'graph',
          severity: applySeverityOverride('low', SLUG, config),
          category: 'quality',
          ruleId: SLUG,
          message: `${occ.simpleName} has the same body as ${primary.qualifiedName} (${primary.filePath}:${String(primary.line)}).`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion:
            'Extract the shared body to a single function and have both call sites import it.',
          metadata: {
            primary: primary.qualifiedName,
            duplicate: occ.qualifiedName,
            groupSize: group.length,
          },
        }),
      );
    }
  }
  return signals;
}

function groupByHash(
  catalog: Catalog,
  minLines: number,
  minBodySize: number,
  features: FeatureTable | undefined,
): readonly (readonly FunctionOccurrence[])[] {
  // Walk the catalog directly; the byBodyHash index dedupes by hash,
  // which is exactly what we need to NOT do here.
  const buckets = new Map<string, FunctionOccurrence[]>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    /* v8 ignore next */
    if (!occs) continue;
    for (const occ of occs) {
      if (!isInterestingForDup(occ, minLines, minBodySize, features)) continue;
      let bucket = buckets.get(occ.bodyHash);
      if (!bucket) {
        bucket = [];
        buckets.set(occ.bodyHash, bucket);
      }
      bucket.push(occ);
    }
  }
  return [...buckets.values()];
}

/**
 * Group occurrences by body hash applying ONLY the kind/test-file
 * exclusions (no size/line floor) — the grouping the aggregate
 * cross-package path consumes. Returns a Map so callers keep the body
 * hash key for suppression bookkeeping.
 */
function groupByHashUnfloored(catalog: Catalog): ReadonlyMap<string, FunctionOccurrence[]> {
  const buckets = new Map<string, FunctionOccurrence[]>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    /* v8 ignore next */
    if (!occs) continue;
    for (const occ of occs) {
      if (!isEligibleKind(occ)) continue;
      let bucket = buckets.get(occ.bodyHash);
      if (!bucket) {
        bucket = [];
        buckets.set(occ.bodyHash, bucket);
      }
      bucket.push(occ);
    }
  }
  return buckets;
}

function lowestByQualifiedName(occs: readonly FunctionOccurrence[]): FunctionOccurrence {
  return occs.reduce((lo, c) => (c.qualifiedName < lo.qualifiedName ? c : lo));
}

/**
 * The kind/test-file exclusions shared by both code paths. Inline arrows
 * / function expressions / module-init occurrences are never an
 * extract/hoist target:
 *  - test-suite arrows with identical 5-line bodies are common boilerplate
 *  - module-inits hash whatever is at top level; identical hashes mean
 *    twin files, not a dup-extraction opportunity
 *  - constructor/getter/setter/method dups are interesting; keep those
 *
 * Test-file occurrences are excluded on both paths.
 */
function isEligibleKind(occ: FunctionOccurrence): boolean {
  if (occ.kind === 'arrow' || occ.kind === 'function-expression' || occ.kind === 'module-init') {
    return false;
  }
  if (occ.inTestFile) return false;
  return true;
}

/**
 * The per-instance dup-body filter: the shared kind/test exclusions plus
 * the size/line floor. The bodySize threshold drops trivial wrappers — a
 * `defineCheck` or pass-through analyze that contains an `if`-guard plus a
 * delegating call. These have identical normalized bodies across many
 * files but are never the right refactor target. Catalogs from older runs
 * that lack `bodySize` skip the size check (treated as "passes").
 */
function isInterestingForDup(
  occ: FunctionOccurrence,
  minLines: number,
  minBodySize: number,
  features: FeatureTable | undefined,
): boolean {
  if (!isEligibleKind(occ)) return false;
  // The bodyLines feature column is the canonical span (computed once in
  // pipeline/features.ts). The inline `endLine − line + 1` here is the single
  // sanctioned graceful-degrade fallback for features-absent calls (3/4-arg
  // test evaluate), not a duplicate of the engine derivation.
  const span = features?.function.get(occ.bodyHash)?.bodyLines ?? (occ.endLine - occ.line + 1);
  if (span < minLines) return false;
  if (occ.bodySize !== undefined && occ.bodySize < minBodySize) return false;
  return true;
}
