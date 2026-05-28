import type { RuleHints } from './lang-adapter/types.js';
import type { Signal } from '@opensip-tools/core';

/**
 * Re-export of `RuleHints` so rule modules under `rules/` can consult
 * adapter-supplied hints without importing from `lang-adapter/`. The
 * dep-cruiser rule `graph-pipeline-no-lang-import` bans `rules/` from
 * reaching into any `lang-*` directory; this re-export is the single
 * sanctioned doorway between the contract layer and rule implementations.
 */
export type { RuleHints } from './lang-adapter/types.js';

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

export type CallResolution =
  | 'static'
  | 'method-dispatch'
  | 'jsx'
  | 'constructor'
  | 'unknown'
  | 'dynamic-string';

export type CallConfidence = 'high' | 'medium' | 'low';

export type Visibility = 'exported' | 'module-local' | 'private';

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
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
}

/**
 * Per-function reverse-reachability score. `direct` is the count of
 * functions whose `calls[]` references this function. `transitive` is
 * the count of distinct functions that can reach this one through any
 * caller chain of length 2..BLAST_MAX_DEPTH (exclusive of the direct
 * set). `score = direct + 0.5 × transitive` — a function-level analogue
 * of codeindex's file-level blast metric.
 */
export interface BlastScore {
  readonly direct: number;
  readonly transitive: number;
  readonly score: number;
}

/** O(1) lookups derived from the catalog. Not persisted. */
export interface Indexes {
  readonly byBodyHash: ReadonlyMap<string, FunctionOccurrence>;
  readonly bySimpleName: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → bodyHash[] (forward). */
  readonly callees: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → bodyHash[] (reverse). */
  readonly callers: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → BlastScore (bounded-depth reverse reachability). */
  readonly blastRadius: ReadonlyMap<string, BlastScore>;
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
  /** Override the inferred entry-point list. */
  readonly entryPointHashes?: readonly string[];
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
 */
export interface Rule {
  /** Rule slug, e.g. "graph:orphan-subtree". Must start with "graph:". */
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
  readonly evaluate: (
    catalog: Catalog,
    indexes: Indexes,
    config: GraphConfig,
    hints?: RuleHints,
  ) => readonly Signal[];
}
