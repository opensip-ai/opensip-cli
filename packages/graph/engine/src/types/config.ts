/**
 * Flat-monorepo synthetic-partition strategy (flat-monorepo-strategy.ts).
 * (A fourth 'community' Louvain strategy was prototyped and discarded by
 * measurement — ADR-0045 B2; recoverable at tag
 * `prototype/louvain-partitioning`.)
 */
export type PartitionStrategy = 'directory-depth' | 'file-count-chunks' | 'hybrid';

/** Per-rule and overall configuration knobs. */
export interface GraphConfig {
  /** Minimum lines for a duplicated-function-body match (defaults: 5). */
  readonly minDuplicateBodyLines?: number;
  /**
   * Minimum normalized body size (in characters) for a duplicated-
   * function-body match. Filters out trivial pass-through wrappers
   * whose duplication is structural, not actionable. Default: 200.
   */
  readonly minDuplicateBodySize?: number;
  /**
   * Minimum number of DISTINCT packages a body hash must appear in to
   * trigger the aggregate cross-package duplication signal for the
   * duplicated-function-body rule. When a body hash qualifies here (and
   * clears `minCrossPackageDuplicateBodySize`), the single aggregate signal
   * is emitted and the per-instance signals for that hash are suppressed.
   * Default: 3.
   */
  readonly minCrossPackageDuplicatePackages?: number;
  /**
   * Normalized-body-size floor (chars) for the aggregate cross-package
   * duplication path. Deliberately LIGHTER than `minDuplicateBodySize` (the
   * per-instance floor) so the aggregate path keeps catching genuinely-small
   * shared utilities copied across packages — its original purpose — while
   * still dropping trivial bodies (empty DI-constructor shims, one-line
   * getters, thin delegators) that are not consolidation targets. Unlike the
   * per-instance path there is NO line floor here. Occurrences whose catalog
   * predates `bodySize` skip this check. Default: 80.
   */
  readonly minCrossPackageDuplicateBodySize?: number;
  /**
   * Minimum estimated Jaccard similarity for `graph:near-duplicate-function-body`
   * (0–1). Default: 0.85.
   */
  readonly minNearDuplicateSimilarity?: number;
  /**
   * Minimum normalized body size (chars) for near-duplicate detection.
   * Default: 200.
   */
  readonly minNearDuplicateBodySize?: number;
  /**
   * LSH band count override for near-duplicate candidate generation. Rows are
   * `NEAR_DUP_SIGNATURE_K / bands` (must divide evenly). Default: 8.
   */
  readonly nearDuplicateLshBands?: number;
  /**
   * Default recipe for `graph` runs when no `--recipe` flag is given (ADR-0022).
   * Tool-scoped: this is the graph tool's recipe namespace, distinct from
   * `fit.recipe` / `sim.recipe`. An unknown name here falls back to the built-in
   * `default` recipe with a warning (config-sourced names are tolerant); an
   * explicit `--recipe` typo still hard-fails.
   */
  readonly recipe?: string;
  /**
   * Flat-large synthetic-partition strategy override. Absent → the
   * layout-recommended default ('hybrid').
   */
  readonly partitionStrategy?: PartitionStrategy;
  /** Override the inferred entry-point list. */
  readonly entryPointHashes?: readonly string[];
  /**
   * `graph:orphan-subtree`: allow flagging exported, zero-caller functions
   * as orphans. Default `false` — public surface is not "dead" merely
   * because it lacks an in-project caller (it may be consumed across a
   * package boundary the call graph cannot resolve). Enable only for repos
   * with trustworthy cross-package call resolution.
   */
  readonly flagExportedOrphans?: boolean;
  /**
   * `graph:orphan-subtree`: allow flagging functions declared in test
   * files as orphans. Default `false` — test-file reachability is the job
   * of `graph:test-only-reachable`; flagging here would double-report and
   * over-trigger on test-only helpers.
   */
  readonly flagTestOrphans?: boolean;
  /**
   * `graph:large-function` warn-band threshold (in body lines). A function
   * whose `bodyLines` exceeds this (but not the error threshold) emits a
   * `medium` signal. In-rule default: 80.
   */
  readonly largeFunctionWarnLines?: number;
  /**
   * `graph:large-function` error-band threshold (in body lines). A function
   * whose `bodyLines` exceeds this emits a `high` signal. In-rule default: 150.
   */
  readonly largeFunctionErrorLines?: number;
  /**
   * `graph:wide-function` warn-band threshold (parameter count). A function
   * with more than this many params (but not more than the error threshold)
   * emits a `medium` signal. In-rule default: 4.
   */
  readonly wideFunctionWarnParams?: number;
  /**
   * `graph:wide-function` error-band threshold (parameter count). A function
   * with more than this many params emits a `high` signal. In-rule default: 7.
   */
  readonly wideFunctionErrorParams?: number;
  /**
   * `graph:high-blast-untested` warn-band threshold — the minimum
   * `blast.score` (an **ABSOLUTE** count, never a percentile — ADR-0001) for an
   * untested function to emit a `medium` signal. In-rule default: 8.
   */
  readonly highBlastWarnThreshold?: number;
  /**
   * `graph:high-blast-untested` error-band threshold — the minimum
   * `blast.score` (an **ABSOLUTE** count, never a percentile — ADR-0001) for an
   * untested function to emit a `high` signal. In-rule default: 20.
   */
  readonly highBlastErrorThreshold?: number;
  /**
   * `graph:cycle` minimum SCC size that emits a `medium` signal. A
   * strongly-connected component with `sccSize >= cycleMinSize` (and not
   * crossing packages, which always wins `high`) emits `medium`. The size-2
   * band is gated separately by `cycleSize2Severity`. In-rule default: 3.
   */
  readonly cycleMinSize?: number;
  /**
   * `graph:cycle` posture for the size-2 band (a 2-member cycle, often
   * legitimate mutual recursion). `'off'` → no signal; `'low'` → a `low`
   * signal. In-rule default: `'off'` (ADR-0001 / Open Question #6).
   */
  readonly cycleSize2Severity?: 'off' | 'low';
  /** Per-rule severity overrides. */
  readonly severityOverrides?: Readonly<Record<string, 'error' | 'warning'>>;
  /**
   * Additive read-time audit source-role globs (P2 Phase 1.3). An occurrence is
   * classified as a TEST source when the adapter's `inTestFile` bit is set OR its
   * project-relative POSIX path matches one of these globs. It is a layer OVER
   * the adapter classification for repositories whose support/test code uses
   * nonconventional paths the adapter heuristics do not recognize — never a
   * replacement, and never inferred from `private: true`, package names, or
   * workspace layout. Package privacy is not a source-role signal. Default empty
   * (adapter classification only). Bounded by {@link MAX_AUDIT_TEST_SOURCE_GLOBS}
   * / {@link MAX_AUDIT_TEST_SOURCE_GLOB_LENGTH} / {@link MAX_AUDIT_TEST_SOURCE_GLOB_TOKENS}.
   */
  readonly auditTestSourceGlobs?: readonly string[];
}

/** Max audit-test source-role glob patterns accepted in one `graph:` block. */
export const MAX_AUDIT_TEST_SOURCE_GLOBS = 64;
/** Max characters in one audit-test source-role glob pattern. */
export const MAX_AUDIT_TEST_SOURCE_GLOB_LENGTH = 256;
/** Max wildcard/character-class tokens (`* ? [ ]`) in one audit-test glob. */
export const MAX_AUDIT_TEST_SOURCE_GLOB_TOKENS = 32;
