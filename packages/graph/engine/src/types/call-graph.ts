/**
 * @fileoverview Core type shapes for the graph tool's seven-stage pipeline.
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

import type { DependencyEdge } from './dependency.js';
import type { PersistedFeatures } from './features.js';
import type { SemanticFactBundle } from './semantic-facts.js';

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
 *
 * `'semantic'` is the cross-shard linker tag: the edge was recovered by the
 * Phase-2 boundary resolver, which links a bare/workspace import specifier +
 * callee name to a UNIQUE exported occurrence in the imported package's export
 * symbol table — exactly what the type checker would conclude. It is a resolved
 * edge (high confidence) and is NOT import-constrained downstream (the linker
 * already proved reachability by construction). The resolver declines (emits no
 * edge) on any ambiguity, so a `'semantic'` edge is never a name-only guess.
 */
export type CallResolution =
  | 'static'
  | 'method-dispatch'
  | 'jsx'
  | 'constructor'
  | 'unknown'
  | 'dynamic-string'
  | 'syntactic'
  | 'semantic';

/** Resolver confidence in a call edge: high (one body), medium (few), low (many or partial). */
export type CallConfidence = 'high' | 'medium' | 'low';

/**
 * Call-graph resolution tier. `exact` = semantic (type-checker-backed),
 * the default that preserves historical behavior; `fast` = syntactic
 * (name + import-graph), no type checker — bounded accuracy for a large
 * cold-build speedup on monorepos.
 */
export type ResolutionMode = 'exact' | 'fast';

/**
 * Whether the catalog was produced by the single-program exact engine or the
 * multi-shard sharded engine. Distinct from {@link ResolutionMode} (semantic
 * vs syntactic edges). Optional on legacy catalogs.
 */
export type CatalogEngineMode = 'exact' | 'sharded';

/** Bounded producer coverage retained so warm context reads stay honest. */
export interface CatalogBuildCoverage {
  /** Complete only when every canonical input went through a fully evidenced build. */
  readonly status: 'complete' | 'partial';
  /** Canonical source files handed to the producing graph build. */
  readonly discoveredFiles: number;
  /** Unique files that reported a parse or walk error. */
  readonly parseErrorFiles: number;
  /** SHA-256 identity of the exact normalized project-relative input set. */
  readonly filesIdentity: string;
}

/**
 * One producing shard's cache-input anchor. Paths are project-relative POSIX;
 * `.` denotes the configured project root.
 */
export interface CatalogShardCacheInput {
  readonly shardId: string;
  readonly rootDir: string;
  readonly configPath?: string;
}

/**
 * How the active graph language adapter was selected for the producing run.
 * Forced = explicit `--language` / `language` input; auto = file-dominance or
 * registry fallback. Optional on pre-feature catalogs — absence means freshness
 * verification is partial.
 */
export type AdapterSelectionEvidence =
  | { readonly mode: 'forced'; readonly requestedId: string; readonly selectedId: string }
  | { readonly mode: 'auto'; readonly selectedId: string };

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
   * recovered `crossShard` edge is `resolution: 'semantic'` — the boundary
   * linker proved the import specifier + callee name resolve to a UNIQUE
   * exported occurrence in the imported package (the same conclusion the type
   * checker reaches), so it is a high-confidence resolved edge. The linker
   * DECLINES on ambiguity rather than guessing, so a `crossShard` edge is never
   * a name-only match. Lets consumers reason about boundary edges (e.g. "the
   * cross-package edges came from the linker, not a single shard").
   * Omitted/false for intra-shard edges; optional for forward-compat.
   */
  readonly crossShard?: boolean;
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
  /**
   * MinHash signature (k=128) of the normalized body for near-clone detection.
   * Optional for pre-feature catalogs; absent values skip the near-duplicate rule.
   */
  readonly bodySignature?: readonly number[];
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
  /**
   * Project-relative file path of the owning occurrence — byte-identical to its
   * `FunctionOccurrence.filePath` (posix-normalized, as the walk emits it). The
   * cross-shard merge keys/stitches edges by
   * `ownerEdgeKey(ownerHash, ownerFile, ownerLine, ownerColumn)` — NOT by
   * `ownerHash` alone — so body-twins (identical bodies in different files, or on
   * one source line) never smear each other's edges (ADR-0003/0136). It is ALSO
   * the directory the cross-shard linker resolves a relative import specifier
   * against (the owner's actual file, not a last-writer-wins `bodyHash→file` guess).
   */
  readonly ownerFile: string;
  /**
   * 1-based declaration line of the owning OCCURRENCE (byte-identical to its
   * `FunctionOccurrence.line`) — NOT the call-site line (`line`, below). Carried
   * so the cross-shard merge keys edges by FULL occurrence identity: a `bodyHash`
   * can appear twice in one file (two byte-identical arrows on a single line),
   * and only `(line, column)` distinguishes those same-file twins (ADR-0136).
   */
  readonly ownerLine: number;
  /** 0-based declaration column of the owning OCCURRENCE (byte-identical to its
   *  `FunctionOccurrence.column`). See {@link ownerLine}. */
  readonly ownerColumn: number;
  /** Syntactic callee simple name (`foo` in `foo()`, rightmost in `a.b.c()`). */
  readonly calleeName: string;
  /** The raw import specifier the name came from, if imported (`'./x.js'`, `'@scope/pkg'`). */
  readonly importSpecifier?: string;
  /**
   * Type-attested target SOURCE file (project-relative) for a cross-package
   * METHOD call `recv.m()` — the package's published `dist/*.d.ts` decl the
   * checker resolved `m` to, mapped to its source. Set INSTEAD of
   * `importSpecifier` (a method name is not an imported binding). The linker pins
   * by (`targetFile` + `calleeName`) against the merged catalog, so cross-package
   * methods resolve through the SAME post-merge linker as cross-package functions
   * — identically in both engines (exact's inline pass declines them under the
   * intra-package pin restriction, so both route here).
   */
  readonly targetFile?: string;
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
 * A name one module re-exports from another, normalized to the data the
 * cross-package export index needs to make a re-exported name resolvable under
 * the RE-EXPORTING package (not just its defining package). Captured by the
 * language adapter's walk (TS: `export … from 'spec'` and the import-then-
 * re-export idiom `export { x }`), carried on the catalog so the engine's
 * cross-shard linker — which builds its index from the MERGED catalog — can
 * follow re-export chains. Pure data (no AST handles); round-trips cache + merge.
 */
export interface ReExportRecord {
  /** Re-exporting file, project-relative POSIX (→ `packageOf` gives the group). */
  readonly fromFile: string;
  /** The name as exposed BY this module. `'*'` for `export * from`. */
  readonly exportedName: string;
  /** The name in the SOURCE module (== `exportedName` unless aliased; `'*'` for star). */
  readonly sourceName: string;
  /** The source module specifier — relative (`'./x'`) or workspace (`'@scope/pkg'`). */
  readonly specifier: string;
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
  /**
   * Adapter selection provenance for the producing run. Optional for
   * forward-compat with pre-feature catalogs; absence yields partial
   * freshness verification (never inferred as fresh).
   */
  readonly adapterSelection?: AdapterSelectionEvidence;
  /**
   * Whether the producing run used the exact or sharded engine. Optional for
   * pre-feature catalogs; absence yields partial freshness verification.
   */
  readonly engineMode?: CatalogEngineMode;
  /** Producing shard inputs; absent on exact and legacy catalogs. */
  readonly shardCacheInputs?: readonly CatalogShardCacheInput[];
  /** Absent on legacy catalogs; context consumers then degrade conservatively. */
  readonly buildCoverage?: CatalogBuildCoverage;
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
  /**
   * Re-export facts captured at walk time (see {@link ReExportRecord}). Present
   * when the adapter emits them; consumed by `buildExportIndex` to resolve a
   * name imported from the package that RE-EXPORTS it (the re-export-chain
   * class). Optional so pre-feature catalogs and non-emitting adapters
   * typecheck; absence means "no re-export following for this catalog."
   */
  readonly reExports?: readonly ReExportRecord[];
  /**
   * Optional compiler-attested declaration + cross-file reference plane
   * (P2 MCP audit Phase 3). Absent = unsupported (pre-feature / fast /
   * non-emitting adapter). Present with empty arrays = supported, no facts.
   * Present with facts = exact TypeScript capture (possibly partial under caps).
   */
  readonly semanticFacts?: SemanticFactBundle;
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
   * Per-occurrence id (`${filePath}:${line}:${column}`) → the occurrence at that
   * source location. Unlike `byBodyHash` (a CONTENT hash that collapses
   * body-twins across packages into one node), an occId is unique per
   * occurrence, so the SCC/cycle feature can key its graph by occurrence and
   * never collapse two distinct functions with identical bodies. Consumed by
   * `computeSccs` (node identity) and `rules/cycle.ts` (member resolution).
   */
  readonly byOccId: ReadonlyMap<string, FunctionOccurrence>;
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
