import type { Signal } from '@opensip-tools/core';

/**
 * `RuleHints` — adapter-supplied per-language rule input. Historically
 * declared in `lang-adapter/types.ts` and re-exported here so rule
 * modules under `rules/` could consult hints without importing from
 * `lang-adapter/` (the dep-cruiser rule `graph-pipeline-no-lang-import`
 * bans `rules/` from reaching into any `lang-*` directory).
 *
 * The original re-export created a `types.ts ↔ lang-adapter/types.ts`
 * file-level cycle reported by `circular-import-detection`. The fix is
 * to host the canonical declaration here in `types.ts` (which sits at
 * the bottom of the engine's type layer) and have `lang-adapter/types.ts`
 * import it from here — inverting the dependency so the cycle is gone.
 */
export interface RuleHints {
  /** Predicate: is this file a test? Path is project-relative. */
  readonly isTestFile?: (filePathProjectRel: string) => boolean;
  /** Globs treated as generated code. */
  readonly generatedFilePatterns?: readonly string[];
  /** Side-effect primitives — fully-qualified names (e.g. 'fs.writeFileSync'). */
  readonly sideEffectPrimitives?: readonly string[];
  /** Throw-statement detection regex for `always-throws-branch`. */
  readonly throwSyntaxRegex?: RegExp;
}

/**
 * @fileoverview Core type shapes for the graph tool's six-stage pipeline.
 *
 * Stage 1 (inventory) emits a Catalog of FunctionOccurrence entries with
 * empty `calls`. Stage 2 (edges) populates `calls` with CallEdge entries
 * that reference back into the catalog by bodyHash. Stage 3 (indexes)
 * produces forward/reverse maps over the catalog.
 *
 * These types are immutable. Every consumer treats them as frozen data;
 * the dep-cruiser and fitness checks (graph-stage-output-immutability)
 * assert this at build time.
 *
 * Per spec §2.2 / §2.4. The catalog is the authority for ids: every
 * CallEdge.to is a bodyHash that already exists in the catalog.
 */

export type FunctionKind =
  | 'function-declaration'
  | 'function-expression'
  | 'arrow'
  | 'method'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'module-init';

/**
 * How a call edge was resolved (static dispatch, method dispatch, JSX, etc.).
 *
 * `'syntactic'` is the fast-mode tag: the edge was resolved from the callee's
 * name plus the file's import graph WITHOUT the type checker. It is always
 * approximate — fast-mode edges carry capped confidence (never `'high'`) so
 * consumers can distinguish them from semantic (`exact`-mode) edges.
 */
export type CallResolution =
  | 'static'
  | 'method-dispatch'
  | 'jsx'
  | 'constructor'
  | 'unknown'
  | 'dynamic-string'
  | 'syntactic';

/** Resolver confidence in a call edge: high (one body), medium (few), low (many or partial). */
export type CallConfidence = 'high' | 'medium' | 'low';

/**
 * Call-graph resolution tier. `exact` = semantic (type-checker-backed),
 * the default that preserves historical behavior; `fast` = syntactic
 * (name + import-graph), no type checker — bounded accuracy for a large
 * cold-build speedup on monorepos.
 */
export type ResolutionMode = 'exact' | 'fast';

/** Function visibility tier: exported from module, module-local, or class-private. */
export type Visibility = 'exported' | 'module-local' | 'private';

/** A function parameter descriptor: name, optionality, and rest-arg flag. */
export interface Param {
  readonly name: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** A resolved call from one function to another. Populated by stage 2. */
export interface CallEdge {
  /** bodyHash[] — one for static, many for polymorphic, empty for unresolved. */
  readonly to: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly resolution: CallResolution;
  readonly confidence: CallConfidence;
  /** Raw call expression text, truncated to ≤ 80 chars. */
  readonly text: string;
  /**
   * True when the call expression appears as an ExpressionStatement
   * (its return value is discarded). Used by `no-side-effect-path` to
   * distinguish "pure helper called for its return value" (correct)
   * from "pure helper called for nothing" (dead computation).
   * Optional for forward-compatibility with pre-discard catalogs.
   */
  readonly discarded?: boolean;
  /**
   * True when this edge was recovered by the cross-shard boundary pass
   * (a sharded build) rather than resolved within a single shard. A
   * `crossShard` edge is therefore `resolution: 'syntactic'` regardless
   * of the build's resolution mode — the ASTs were gone by the time it
   * was resolved, so only the callee name + import specifier were
   * available. Lets consumers reason about boundary edges (e.g. "my
   * low-confidence edges are the cross-package ones, which is expected").
   * Omitted/false for intra-shard edges; optional for forward-compat.
   */
  readonly crossShard?: boolean;
}

/**
 * A resolved module-level dependency edge — an `import` / `from … import` /
 * `require` / `use` statement from one source file to another (or to an
 * external package the catalog doesn't track). Attached to module-init
 * occurrences only.
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498) — preserves the
 * `depends_on` edge kind required by opensip's
 * `dependencyEdgesBetweenModules` query, which dispatch ticket grouping
 * and review-panel blast-radius depend on.
 *
 * `to.length === 0` means the import target is outside the catalog
 * (typically an external npm/PyPI/crates.io package). `specifier`
 * preserves the raw import string so unresolved edges remain traceable.
 */
export interface DependencyEdge {
  /** bodyHash[] of the target module-init occurrence(s). Empty when the
   *  import resolves to a module outside the catalog (external package). */
  readonly to: readonly string[];
  /** 1-based line of the import / require / use statement. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** The raw import specifier — `'./foo'`, `'@opensip/core'`, `'os.path'`,
   *  `'std::collections'`, etc. Preserved for unresolved-edge attribution. */
  readonly specifier: string;
}

/** A single callable function or method, by simple name + per-occurrence record. */
export interface FunctionOccurrence {
  /** sha256(normalized body) — the primary identifier. */
  readonly bodyHash: string;
  /**
   * Length of the normalized body in characters (comments stripped,
   * whitespace collapsed). Used by `duplicated-function-body` to skip
   * trivial wrapper bodies whose duplication is not actionable.
   * Optional for forward-compatibility with pre-bodySize catalogs;
   * absent values are treated as "passes the threshold."
   */
  readonly bodySize?: number;
  /** "saveBaseline", "<arrow:gate.ts:42:7>", "<module-init:gate.ts>". */
  readonly simpleName: string;
  /** "fitness/engine/src/gate.saveBaseline" — for human display. */
  readonly qualifiedName: string;
  /** Project-relative path. */
  readonly filePath: string;
  /**
   * The package this occurrence belongs to — the `name` of its nearest
   * enclosing `package.json`, else the top-level path segment. Assigned by
   * `assignPackages` at build time so consumers (coupling grid, edge
   * constraint) bucket by real package boundary, not a path heuristic.
   * Optional for forward-compat; absent ⇒ derive from `filePath`.
   */
  readonly package?: string;
  /** 1-based line where the function declaration begins. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  readonly endLine: number;
  readonly kind: FunctionKind;
  readonly params: readonly Param[];
  readonly returnType: string | null;
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly visibility: Visibility;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  /** Populated by stage 2. Empty after stage 1. */
  readonly calls: readonly CallEdge[];
  /**
   * Module-level depends-on edges. Only populated on `module-init`
   * occurrences (one per file); absent on all other occurrence kinds.
   * Optional for forward-compatibility with pre-Phase-4 catalogs on
   * disk — absent values are treated as "no dependencies emitted by
   * this adapter."
   *
   * Phase 4 of opensip's substrate consolidation (DEC-498). The opensip
   * catalog-json renderer emits these as `edge_kind: 'depends_on'` rows
   * for opensip's `dependencyEdgesBetweenModules` query.
   */
  readonly dependencies?: readonly DependencyEdge[];
}

/** Stage 1's parse-error record (e.g., file unparseable; reported but does not abort the run). */
export interface ParseError {
  readonly filePath: string;
  readonly message: string;
}

/**
 * A call site a shard worker could NOT resolve within its own files —
 * the callee name is not among the shard's own occurrences. Plain,
 * JSON-safe data (no AST): the cross-shard pass re-resolves these against
 * the global merged catalog + import graph, syntactically.
 *
 * Emitted by an adapter's `resolveCallSites` when `emitBoundaryCalls` is
 * set (only the adapter can extract a callee name from its AST), and
 * carried across the worker boundary inside a `ShardBuildResult`.
 */
export interface CrossBoundaryCall {
  /** bodyHash of the enclosing function (an occurrence in this shard's fragment). */
  readonly ownerHash: string;
  /** Syntactic callee simple name (`foo` in `foo()`, rightmost in `a.b.c()`). */
  readonly calleeName: string;
  /** The raw import specifier the name came from, if imported (`'./x.js'`, `'@scope/pkg'`). */
  readonly importSpecifier?: string;
  /** 1-based line of the call site. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  /** Truncated call-expression text for display (≤ 80 chars, the CallEdge.text contract). */
  readonly text: string;
  /**
   * True when the call's return value is discarded (ExpressionStatement).
   * Carried so the recovered cross-shard CallEdge preserves the `discarded`
   * flag that `no-side-effect-path` relies on.
   */
  readonly discarded?: boolean;
}

/**
 * The catalog: functions keyed by simple name. Multiple occurrences
 * per name.
 *
 * v3 — generic over language. The language-pluggability work replaced
 * the v2 fields `tsConfigPath` and `tsCompilerVersion` with adapter-supplied
 * `language` (the registered adapter id) and `cacheKey` (an opaque
 * per-adapter invalidation key). v2 catalogs on disk return
 * `{ kind: 'invalid', reason: 'version-mismatch' }` from
 * `classifyCatalog`, so users see exactly one cold rebuild.
 */
export interface Catalog {
  readonly version: '3.0';
  readonly tool: 'graph';
  /** Adapter id — currently always 'typescript'; future adapters add their own. */
  readonly language: string;
  readonly builtAt: string;
  /**
   * Opaque per-adapter cache invalidation key. The TypeScript adapter
   * sets `ts-${ts.version}-${tsconfigContentHash}`. Different adapters
   * MUST emit different prefixes so cross-adapter accidents (e.g. a
   * Python catalog read by the TS adapter) hash-mismatch immediately.
   */
  readonly cacheKey: string;
  /**
   * Concatenated fingerprint of the source files at build time
   * (mtime + size per file). Used by cache invalidation; absence
   * means "this catalog was built before fingerprinting landed,"
   * which invalidates the catalog conservatively.
   */
  readonly filesFingerprint?: string;
  /**
   * The resolution tier that produced this catalog. `'exact'` =
   * semantic (type-checker-backed); `'fast'` = syntactic (approximate).
   * Optional for forward-compatibility: catalogs persisted before fast
   * mode landed have no marker, and **absence is interpreted as
   * `'exact'`** (the historical behavior). Consumers that need to know
   * whether edges are approximate read this field.
   */
  readonly resolutionMode?: ResolutionMode;
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
  /**
   * Derived feature columns materialized for the decoupled dashboard
   * (ADR-0006): present ONLY when the producing run requested columns via
   * `emitFeatures`. A default run persists no features. Optional so pre-
   * feature catalogs and external callers typecheck, and so the plain
   * widening to `GraphCatalog` stays cast-free.
   */
  readonly features?: PersistedFeatures;
}

/** O(1) lookups derived from the catalog. Not persisted. */
export interface Indexes {
  readonly byBodyHash: ReadonlyMap<string, FunctionOccurrence>;
  /**
   * bodyHash → ALL occurrences sharing that body. Unlike `byBodyHash`
   * (one occurrence per hash, content-dedup), this preserves every
   * occurrence so a callee whose body is duplicated across packages can be
   * disambiguated to the correct package. Consumed by `resolveCallee`.
   */
  readonly occurrencesByHash: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  /**
   * Project-relative filePath → set of package groups that file's module
   * imports (derived from the file's module-init `dependencies[]` resolved
   * to packages). Empty for files with no resolved imports — and empty in
   * `fast` mode, where `dependencies[]` is not populated. Lets
   * `resolveCallee` constrain a duplicated-body callee to a package the
   * caller actually depends on.
   */
  readonly importedPackagesByFile: ReadonlyMap<string, ReadonlySet<string>>;
  readonly bySimpleName: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → bodyHash[] (forward). */
  readonly callees: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → bodyHash[] (reverse). */
  readonly callers: ReadonlyMap<string, readonly string[]>;
}

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
 * One strongly-connected component of the call graph (Tarjan over `callees`).
 * Singletons are included by the algorithm. `id` is member-derived and stable
 * across runs so Plan D predicates and the dashboard cycle-grouping read a
 * deterministic key. Populated only when `'scc'` was requested.
 */
export interface SccFeatures {
  /** `scc:${sortedMembers[0]}` — stable, member-derived (resolves the spec
   *  Open Question on the SCC id scheme). */
  readonly id: string;
  /** Member `bodyHash`es, sorted (determinism). */
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
}

/** Resolution-stat counters returned alongside the catalog by stage 2. */
export interface ResolutionStats {
  readonly totalCallSites: number;
  readonly resolvedHigh: number;
  readonly resolvedMedium: number;
  readonly resolvedLow: number;
  readonly unresolved: number;
}

/** Verdict produced by an edge resolver — pre-CallEdge shape. */
export interface ResolverVerdict {
  readonly to: readonly string[];
  readonly resolution: CallResolution;
  readonly confidence: CallConfidence;
}

/**
 * A rule consumes frozen catalog/indexes/config and returns Signals.
 *
 * The fourth parameter `hints` carries the active language adapter's
 * `RuleHints` (side-effect primitives, throw-syntax regex, test-file
 * predicate, generated-file globs). It is optional so test code may
 * still invoke `rule.evaluate(catalog, indexes, config)` without
 * threading hints through. Rules that don't need hints can ignore it;
 * rules that do consult hints MUST also implement a TypeScript-shaped
 * fallback so the rule degrades gracefully when an adapter does not
 * supply the relevant hint (per the graph rules-and-gating fidelity
 * matrix).
 *
 * The fifth parameter `features` (Plan C) carries the engine-computed
 * `FeatureTable` — the columns a rule declares via `featureDeps`. Like
 * `hints`, it is optional so test code may call `rule.evaluate(catalog,
 * indexes, config)` (3-arg) or `(…, hints)` (4-arg) without threading
 * features. A rule that reads a column MUST degrade gracefully (recompute
 * locally) when `features` is absent.
 */
export interface Rule {
  /** Rule slug, e.g. "graph:orphan-subtree". Must start with "graph:". */
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
  /**
   * Feature columns this rule reads. The features stage computes the UNION
   * of every enabled rule's deps (+ the caller's `emitFeatures`) and nothing
   * else — lazy/needed-only. Absent ⇒ this rule reads no features.
   */
  readonly featureDeps?: readonly FeatureColumn[];
  readonly evaluate: (
    catalog: Catalog,
    indexes: Indexes,
    config: GraphConfig,
    hints?: RuleHints,
    features?: FeatureTable,
  ) => readonly Signal[];
}
