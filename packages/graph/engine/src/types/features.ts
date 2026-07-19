// ── Feature/dataset layer (Plan C) ─────────────────────────────────
//
// A derived-from-catalog dataset, sibling to `Indexes`. Unlike `Indexes`
// (purely in-memory, never persisted), the feature table CAN be partially
// persisted into the catalog JSON — but ONLY the columns the decoupled
// dashboard renders, and ONLY when a dashboard-bound run requests them
// (ADR-0006). In-engine rules consume it as a plain recomputed view (never
// persisted for their sake). Computed in one pass in `pipeline/features.ts`;
// every field is `readonly`, frozen-data like every other stage output.

/**
 * Blast radius for one function: how much of the graph a change here can
 * ripple through, via a bounded reverse BFS over the callers adjacency.
 * `direct` = the function's direct callers; `transitive` = set-deduped
 * callers reached at depth 2..5; `score = direct + 0.5 × transitive`
 * (verbatim from the dashboard's former `code-paths/indexes.ts`).
 */
export interface BlastScore {
  readonly direct: number;
  readonly transitive: number;
  readonly score: number;
}

/**
 * Per-function feature columns, keyed by `bodyHash`. `bodyLines` is always
 * present when the `function` grain is computed; every other column is
 * optional because it is populated only when its driving `FeatureColumn`
 * was requested (lazy/needed-only).
 */
export interface FunctionFeatures {
  /** `endLine − line + 1` of the `byBodyHash` winner occurrence. The
   *  canonical home for the span formula the dup-body / no-side-effect
   *  rules used to inline. */
  readonly bodyLines: number;
  /** Blast radius (depth-5 reverse BFS). Present only when `'blast'` was
   *  requested. */
  readonly blast?: BlastScore;
  /** True when the function is reachable from an inferred entry point
   *  (BFS over `callees` from `inferEntryPoints` + `config.entryPointHashes`).
   *  Present only when `'reachableFromEntry'` was requested. */
  readonly reachableFromEntry?: boolean;
  /** True when the function is reachable from a NON-test (production) entry
   *  point. The companion flag the `test-only-reachable` rule reads alongside
   *  `reachableOnlyFromTests`. Present only when `'reachableOnlyFromTests'`
   *  was requested. */
  readonly testReachable?: boolean;
  /** True when the function has callers, is NOT reachable from any production
   *  entry point, and ALL of its callers live in test files (the
   *  `test-only-reachable` rule's reachability predicate). Present only when
   *  `'reachableOnlyFromTests'` was requested. */
  readonly reachableOnlyFromTests?: boolean;
}

/**
 * Per-package feature columns, keyed by package name. Both degrees count
 * DISTINCT packages (self-edges included, matching the coupling matrix's
 * diagonal). Populated only when `'packageCoupling'` was requested.
 */
export interface PackageFeatures {
  /** Distinct callee packages this package calls into (incl. itself). */
  readonly couplingOut: number;
  /** Distinct caller packages that call into this package (incl. itself). */
  readonly couplingIn: number;
}

/**
 * One strongly-connected component of the call graph (Tarjan over an
 * OCCURRENCE-level adjacency — nodes are occIds, edges `resolveCallee`-
 * disambiguated). Singletons are included by the algorithm. `id` is
 * member-derived and stable across runs so Plan D predicates and the dashboard
 * cycle-grouping read a deterministic key. Populated only when `'scc'` was
 * requested.
 *
 * Members are occIds (`${filePath}:${line}:${column}`), NOT bodyHashes:
 * occurrence identity is package-unique, so two functions with identical bodies
 * in different packages stay distinct nodes (no false cross-package phantom).
 * Resolve a member to its occurrence via `Indexes.byOccId`.
 */
export interface SccFeatures {
  /** `scc:${sortedMembers[0]}` — stable, member-derived (resolves the spec
   *  Open Question on the SCC id scheme). */
  readonly id: string;
  /** Member occIds (`${filePath}:${line}:${column}`), sorted (determinism). */
  readonly members: readonly string[];
  /** `members.length`. */
  readonly sccSize: number;
  /** True when the component's members span more than one distinct package. */
  readonly crossesPackages: boolean;
}

/**
 * One directed package-coupling edge — `count` static call edges from
 * `callerPackage` into `calleePackage` (via the canonical `resolveCallee`
 * disambiguation). Populated only when `'packageCoupling'` was requested.
 */
export interface PackageEdgeFeature {
  readonly callerPackage: string;
  readonly calleePackage: string;
  readonly count: number;
}

/**
 * Lazy column request. `buildFeatures` computes the UNION of the enabled
 * rule set's declared `featureDeps` plus the caller's `emitFeatures`, and
 * NOTHING else. Each column maps to the entity rows it populates:
 *  - `bodyLines` / `blast` / `reachableFromEntry` / `reachableOnlyFromTests`
 *    → `function` rows;
 *  - `packageCoupling` → `package` rows (`couplingOut`/`couplingIn`) AND
 *    `edge` rows (`count`) — one column, one pass;
 *  - `scc` → `scc` rows.
 */
export type FeatureColumn =
  | 'bodyLines'
  | 'blast'
  | 'reachableFromEntry'
  | 'reachableOnlyFromTests'
  | 'packageCoupling'
  | 'scc';

/**
 * The multi-entity feature table — derived from `Catalog` + `Indexes`,
 * computed in `pipeline/features.ts`. A *plain view* by default (ADR-0006):
 * rules consume it directly; only the dashboard columns are ever persisted,
 * and only when requested. Each entity is empty when none of its driving
 * columns were requested.
 */
export interface FeatureTable {
  readonly function: ReadonlyMap<string, FunctionFeatures>;
  readonly package: ReadonlyMap<string, PackageFeatures>;
  readonly scc: readonly SccFeatures[];
  readonly edge: readonly PackageEdgeFeature[];
}

/** JSON-safe mirror of `FunctionFeatures` (identical fields). */
export type PersistedFunctionFeatures = FunctionFeatures;

/**
 * The only-when-needed materialized form persisted into the catalog JSON for
 * the decoupled dashboard (ADR-0006). Maps become records; arrays pass
 * through. Every entity is optional — only requested entities are present, so
 * an empty request projects to `{}` and a lean default-run persists no blob.
 */
export interface PersistedFeatures {
  readonly function?: Readonly<Record<string, PersistedFunctionFeatures>>;
  readonly package?: Readonly<Record<string, PackageFeatures>>;
  readonly scc?: readonly SccFeatures[];
  readonly edge?: readonly PackageEdgeFeature[];
}
