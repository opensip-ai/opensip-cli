import type { Signal } from '@opensip-tools/core';

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
}

/** A single callable function or method, by simple name + per-occurrence record. */
export interface FunctionOccurrence {
  /** sha256(normalized body) — the primary identifier. */
  readonly bodyHash: string;
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
}

/** Stage 1's parse-error record (e.g., file unparseable; reported but does not abort the run). */
export interface ParseError {
  readonly filePath: string;
  readonly message: string;
}

/** The catalog: functions keyed by simple name. Multiple occurrences per name. */
export interface Catalog {
  readonly version: '2.0';
  readonly tool: 'graph';
  readonly language: 'typescript';
  readonly builtAt: string;
  readonly tsConfigPath: string;
  readonly tsCompilerVersion: string;
  readonly functions: Readonly<Record<string, readonly FunctionOccurrence[]>>;
}

/** O(1) lookups derived from the catalog. Not persisted. */
export interface Indexes {
  readonly byBodyHash: ReadonlyMap<string, FunctionOccurrence>;
  readonly bySimpleName: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → bodyHash[] (forward). */
  readonly callees: ReadonlyMap<string, readonly string[]>;
  /** bodyHash → bodyHash[] (reverse). */
  readonly callers: ReadonlyMap<string, readonly string[]>;
}

/** Per-rule and overall configuration knobs. */
export interface GraphConfig {
  /** Minimum lines for a duplicated-function-body match (defaults: 5). */
  readonly minDuplicateBodyLines?: number;
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

/** A rule consumes frozen catalog/indexes/config and returns Signals. */
export interface Rule {
  /** Rule slug, e.g. "graph:orphan-subtree". Must start with "graph:". */
  readonly slug: string;
  readonly defaultSeverity: 'error' | 'warning';
  readonly evaluate: (
    catalog: Catalog,
    indexes: Indexes,
    config: GraphConfig,
  ) => readonly Signal[];
}
