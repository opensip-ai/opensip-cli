/**
 * GraphLanguageAdapter — the contract every language implements to
 * participate in the graph tool.
 *
 * The interface signature below is the canonical source for adapter
 * authors. Every adapter must satisfy the 9 contract invariants
 * (I-1 through I-9) documented inline on each method.
 *
 * Six methods total:
 *   1. discoverFiles    — resolve which files belong to the project
 *   2. parseProject     — build adapter-internal parse state
 *   3. walkProject      — emit occurrences + located call-site records
 *   4. resolveCallSites — produce CallEdge[] keyed by owner bodyHash
 *   5. cacheKey         — opaque per-adapter cache invalidation key
 *   6. ruleHints        — optional per-language rule-input hints
 */

import type {
  Catalog,
  CallEdge,
  CrossBoundaryCall,
  DependencyEdge,
  FunctionOccurrence,
  ParseError,
  ReExportRecord,
  ResolutionMode,
  ResolutionStats,
  RuleHints,
} from '../types.js';

/**
 * Adapter-internal parse state. Opaque to the engine; the engine
 * passes P from parseProject() back into walkProject() and
 * resolveCallSites() unchanged. TypeScript holds a `ts.Program`;
 * a tree-sitter adapter would hold a `Map<filePath, Tree>` plus a
 * project-wide call-graph hint.
 *
 * Notation only — `ParsedProject` is the literal `unknown`. Adapter
 * authors parameterize their `GraphLanguageAdapter<P>` with their
 * concrete type (e.g. `TypescriptParsedProject`) and the engine
 * sees `unknown` because it doesn't introspect.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- doc-only alias used in interface signatures below
export type ParsedProject = unknown;

// ── method 1 ──────────────────────────────────────────────────────

export interface DiscoverInput {
  /** Absolute, realpath-normalized cwd. */
  readonly cwd: string;
  /** User-supplied --tsconfig (or analogue) override; optional. */
  readonly configPathOverride?: string;
}

export interface DiscoverOutput {
  /** The resolved project root (= cwd, normalized). */
  readonly projectDirAbs: string;
  /** Absolute, realpath-normalized, sorted, deduped file paths. */
  readonly files: readonly string[];
  /** Path to the language config file (tsconfig.json, pyproject.toml, etc.). */
  readonly configPathAbs?: string;
  /** Adapter-internal compiler options, threaded into parseProject. */
  readonly compilerOptions?: unknown;
}

// ── method 2 ──────────────────────────────────────────────────────

export interface ParseInput {
  readonly projectDirAbs: string;
  readonly files: readonly string[];
  /**
   * Absolute path to the language config file that anchored discovery
   * (tsconfig.json, pyproject.toml, Cargo.toml, etc.). Optional —
   * adapters that don't need a config-file anchor may ignore it.
   *
   * Threaded through DiscoverOutput so synthetic-partition discovery
   * in flat monorepos can hand each partition's config to the parser
   * (e.g. tsc's project-reference / rootDir resolution depends on
   * knowing which tsconfig the program belongs to).
   */
  readonly configPathAbs?: string;
  readonly compilerOptions?: unknown;
  /**
   * The resolution tier the run was invoked with. The engine always
   * supplies it (defaulting to `'exact'` at the CLI boundary). An
   * adapter that only implements semantic parsing MAY ignore a `'fast'`
   * value and behave as `'exact'` — the contract permits, but does not
   * require, a per-adapter fast implementation.
   */
  readonly resolutionMode: ResolutionMode;
}

export interface ParseOutput<P = ParsedProject> {
  readonly project: P;
  readonly parseErrors: readonly ParseError[];
}

// ── method 3 ──────────────────────────────────────────────────────

export interface WalkInput<P = ParsedProject> {
  readonly project: P;
  readonly projectDirAbs: string;
  readonly files: readonly string[];
}

/**
 * One call-site record emitted by walkProject. Opaque node + source
 * handles flow back into resolveCallSites unchanged. The 'creation'
 * kind is for parent → nested-callable creation edges (arrows,
 * function-expressions, etc.); the resolver pass emits a static
 * high-confidence edge without consulting any resolver.
 */
export interface CallSiteRecord {
  /** Adapter handle to the AST node. */
  readonly nodeRef: unknown;
  /** Adapter handle to the source file containing the call. */
  readonly sourceFileRef: unknown;
  /** bodyHash of the enclosing function-shape. Always exists in WalkOutput.occurrences (I-3). */
  readonly ownerHash: string;
  /** 'call' dispatches to resolvers; 'creation' produces a static edge. */
  readonly kind: 'call' | 'creation';
  /** For 'creation' kind, the bodyHash of the nested callable. */
  readonly childHash?: string;
}

/**
 * One module-level dependency site emitted by walkProject. Represents
 * a single `import` / `from … import` / `require` / `use` statement.
 * Resolved to bodyHashes by `resolveCallSites` (which returns
 * `dependenciesByOwner` alongside the existing `edgesByOwner`).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498). Optional —
 * adapters that don't emit dependency sites are not required to populate
 * this shape; the engine treats absence as "no module-level edges
 * available for this language."
 */
export interface DependencySiteRecord {
  /** Adapter handle to the AST node (import/require/use statement). */
  readonly nodeRef: unknown;
  /** Adapter handle to the source file containing the import. */
  readonly sourceFileRef: unknown;
  /** bodyHash of the enclosing file's module-init occurrence. */
  readonly ownerHash: string;
  /** The raw import specifier — `'./foo'`, `'@opensip/core'`, etc. */
  readonly specifier: string;
  /** 1-based line of the import statement. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
}

export interface WalkOutput {
  readonly occurrences: Record<string, FunctionOccurrence[]>;
  readonly callSites: readonly CallSiteRecord[];
  /** Optional — Phase 4 (DEC-498) addition. Adapters that emit
   *  module-level dependency edges populate this; others may omit. */
  readonly dependencySites?: readonly DependencySiteRecord[];
  /** Optional — re-export facts (see {@link ReExportRecord}). Adapters that
   *  resolve re-export chains populate this; others may omit. Carried onto the
   *  catalog so the engine's cross-shard export index can follow re-exports. */
  readonly reExports?: readonly ReExportRecord[];
  readonly parseErrors: readonly ParseError[];
}

// ── method 4 ──────────────────────────────────────────────────────

export interface ResolveInput<P = ParsedProject> {
  readonly project: P;
  readonly catalog: Catalog;
  readonly callSites: readonly CallSiteRecord[];
  /** Optional — Phase 4 (DEC-498) addition. The engine threads any
   *  `dependencySites` returned from walkProject back into resolveCallSites
   *  so the resolver can produce module-level edges in the same pass as
   *  call resolution. */
  readonly dependencySites?: readonly DependencySiteRecord[];
  readonly projectDirAbs: string;
  /**
   * The resolution tier. `'exact'` runs the semantic, type-checker-backed
   * resolvers; `'fast'` runs the syntactic resolver (name + import graph)
   * and labels every edge `'syntactic'` with capped confidence. Adapters
   * that only implement exact resolution may ignore a `'fast'` value.
   */
  readonly resolutionMode: ResolutionMode;
  /**
   * Sharded-build flag (plan #2). When `true`, the adapter additionally
   * emits a `CrossBoundaryCall` for every call site whose callee name is
   * NOT among the shard's own occurrences — the candidates the cross-shard
   * boundary pass re-resolves against the global catalog. Boundary
   * detection is purely syntactic (name + import specifier), independent
   * of `resolutionMode`. Adapters that don't implement it leave
   * `boundaryCalls` undefined. Omitted/false in single-process builds.
   */
  readonly emitBoundaryCalls?: boolean;
}

export interface ResolveOutput {
  /** Map: owner bodyHash → CallEdges produced by resolution. */
  readonly edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>;
  /**
   * Optional — Phase 4 (DEC-498) addition. Map: module-init bodyHash →
   * DependencyEdges produced by import-site resolution. Engine's
   * stitchEdges merges these into `FunctionOccurrence.dependencies`.
   * Adapters that don't resolve dependencies may omit.
   */
  readonly dependenciesByOwner?: ReadonlyMap<string, readonly DependencyEdge[]>;
  /**
   * Sharded-build output (plan #2). Populated only when the input set
   * `emitBoundaryCalls`: the call sites that didn't resolve within this
   * shard's files, as plain descriptors the cross-shard pass re-resolves
   * globally. Undefined when not requested or not implemented.
   */
  readonly boundaryCalls?: readonly CrossBoundaryCall[];
  readonly stats: ResolutionStats;
}

// ── method 5 ──────────────────────────────────────────────────────

export interface CacheKeyInput {
  readonly projectDirAbs: string;
  readonly configPathAbs?: string;
  readonly compilerOptions?: unknown;
  /**
   * The resolution tier. Adapters MUST fold this into the returned key so
   * fast and exact catalogs never collide in the cache (a mode switch must
   * be a cache miss against the other tier, not a wrong-tier reuse).
   */
  readonly resolutionMode: ResolutionMode;
}

// ── method 6 ──────────────────────────────────────────────────────

// `RuleHints` is declared in `../types.ts` (the engine's shared type
// layer) so it can be re-imported by rules without crossing into
// `lang-adapter/`. Re-exported here so adapter authors still see it on
// the adapter contract surface they pull from `lang-adapter/types.js`.
export type { RuleHints } from '../types.js';

// ── the interface ─────────────────────────────────────────────────

export interface GraphLanguageAdapter<P = ParsedProject> {
  /** Stable identifier. Stored in Catalog.language. */
  readonly id: string;
  /** Lowercase file extensions including the leading dot. */
  readonly fileExtensions: readonly string[];
  /** Optional human-readable name; defaults to id. */
  readonly displayName?: string;

  discoverFiles(input: DiscoverInput): DiscoverOutput;
  parseProject(input: ParseInput): ParseOutput<P>;
  walkProject(input: WalkInput<P>): WalkOutput;
  /**
   * Resolve call sites to edges. May return synchronously OR a Promise: the
   * resolve stage is a tool's heaviest loop (tens of thousands of call sites),
   * so an adapter MAY run it cooperatively — yielding to the event loop every N
   * sites — so the live view's spinner animates instead of freezing for the
   * stage's whole duration (ADR-0016). The orchestrator always `await`s the
   * result, so sync adapters are unaffected.
   */
  resolveCallSites(input: ResolveInput<P>): ResolveOutput | Promise<ResolveOutput>;
  cacheKey(input: CacheKeyInput): string;

  readonly ruleHints?: RuleHints;
}
