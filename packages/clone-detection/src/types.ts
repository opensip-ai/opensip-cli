/**
 * Tool-neutral input + finding types for the clone-detection substrate.
 *
 * `CloneCandidate` is a deliberate STRUCTURAL SUBSET of graph's runtime
 * `FunctionOccurrence` (ISP — the algorithms accept only the fields the math needs;
 * graph passes its occurrences directly by structural assignability, yagni builds the
 * same shape from `lang-typescript`). This is the DIP/ISP boundary that keeps the
 * substrate free of either tool's types — NOT a future-proofing hook. The cross-tool
 * parity test (Phase 2) is the seam that proves both producers agree on these fields;
 * the dep-cruiser leaf rule is the compile-time invariant.
 */

/** Function-shape classification — mirrors graph's `FunctionKind` for structural assignability. */
export type FunctionKind =
  | 'function-declaration'
  | 'function-expression'
  | 'arrow'
  | 'method'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'module-init';

/** The minimal per-function input the detection algorithms consume. */
export interface CloneCandidate {
  /** sha256(normalized body) — the grouping key. */
  readonly bodyHash: string;
  /** MinHash signature (k=128) — near-duplicate only; absent ⇒ skipped by `findNearDuplicates`. */
  readonly bodySignature?: readonly number[];
  /** Normalized body length in chars; absent ⇒ "passes the size floor". */
  readonly bodySize?: number;
  /** Canonical body span in lines; absent ⇒ fall back to `endLine − line + 1`. */
  readonly bodyLines?: number;
  readonly kind: FunctionKind;
  readonly inTestFile: boolean;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly simpleName: string;
  readonly qualifiedName: string;
  /** Resolved package the caller assigns (graph: `pkgOf`; yagni: nearest `package.json`). */
  readonly package?: string;
  /**
   * Resolved language the caller assigns for the near-duplicate same-language gate
   * (graph: `languageOfFile(filePath)`). `languageOfFile` stays in graph (single
   * caller — rule of three not met), so the substrate compares this pre-resolved
   * field rather than importing a language map. Absent ⇒ the pair is skipped, exactly
   * as `languageOfFile(...) === undefined` did.
   */
  readonly language?: string;
}

/** Thresholds for `findDuplicateBodies` (exact). Absent fields take the policy defaults. */
export interface DupOpts {
  readonly minLines?: number;
  readonly minBodySize?: number;
  readonly minCrossPackagePackages?: number;
  readonly minCrossPackageBodySize?: number;
}

/** Thresholds for `findNearDuplicates` (MinHash/LSH). Absent fields take the policy defaults. */
export interface NearDupOpts {
  readonly minSimilarity?: number;
  readonly minBodySize?: number;
  readonly lshBands?: number;
}

/** A per-instance exact-duplicate group. `members[0]` is the primary (lowest qualifiedName). */
export interface DuplicateGroup {
  readonly bodyHash: string;
  readonly members: readonly CloneCandidate[];
}

/** A body duplicated across ≥ `minCrossPackagePackages` distinct packages. */
export interface CrossPackageAggregate {
  readonly bodyHash: string;
  readonly anchor: CloneCandidate;
  readonly packages: readonly string[];
  readonly occurrenceCount: number;
}

/** Result of {@link findDuplicateBodies}: cross-package aggregates + the surviving per-instance groups. */
export interface DuplicateFindings {
  readonly aggregates: readonly CrossPackageAggregate[];
  readonly groups: readonly DuplicateGroup[];
}

/** A near-duplicate cluster (connected component over LSH/Jaccard edges). */
export interface NearDuplicateCluster {
  readonly anchor: CloneCandidate;
  readonly nearMembers: readonly string[];
  readonly exactMembers: readonly string[];
  readonly estimatedSimilarity: number;
  readonly clusterSize: number;
}
