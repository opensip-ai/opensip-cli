/**
 * Type-only structural shapes for the v0.3 Code Paths panel.
 *
 * The graph engine's catalog.json is consumed here purely by JSON shape;
 * this file MUST NOT import from `@opensip-tools/graph`. The shape is
 * intentionally duplicated as readonly structural types — this decouples
 * the dashboard panel from the graph engine's runtime types so
 * @opensip-tools/contracts stays a pure type-only kernel boundary.
 *
 * Runtime exports are forbidden. Only `export type` and `export interface`.
 */

export type GraphFunctionKind =
  | 'function-declaration'
  | 'function-expression'
  | 'arrow'
  | 'method'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'module-init';

export type GraphCallResolution =
  | 'static'
  | 'method-dispatch'
  | 'jsx'
  | 'constructor'
  | 'unknown'
  | 'dynamic-string'
  /** Fast-mode (syntactic) edge: resolved from name + import graph, no
   *  type checker. Always approximate — carries capped confidence. */
  | 'syntactic';

export type GraphCallConfidence = 'high' | 'medium' | 'low';

/** Mirror of the engine's `ResolutionMode`. `exact` = semantic;
 *  `fast` = syntactic (approximate). Kept structurally in sync. */
export type GraphResolutionMode = 'exact' | 'fast';

export type GraphVisibility = 'exported' | 'module-local' | 'private';

export interface GraphParam {
  readonly name: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

export interface GraphCallEdge {
  readonly to: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly resolution: GraphCallResolution;
  readonly confidence: GraphCallConfidence;
  readonly text: string;
  /** True for an edge recovered by the cross-shard boundary pass (always
   *  syntactic). Mirrors the engine `CallEdge.crossShard`. */
  readonly crossShard?: boolean;
}

export interface GraphFunctionOccurrence {
  readonly bodyHash: string;
  readonly simpleName: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  /**
   * The package this occurrence belongs to — the `name` of its nearest
   * enclosing `package.json` (e.g. `@opensip-tools/fitness`), or the
   * top-level path segment when there is no manifest. Computed at build
   * time (the dashboard has no filesystem access). Absent on pre-2.4.2
   * catalogs; consumers fall back to deriving it from `filePath`.
   */
  readonly package?: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly kind: GraphFunctionKind;
  readonly params: readonly GraphParam[];
  readonly returnType: string | null;
  readonly enclosingClass: string | null;
  readonly decorators: readonly string[];
  readonly visibility: GraphVisibility;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly calls: readonly GraphCallEdge[];
}

/**
 * Public catalog shape consumed by the dashboard.
 *
 * v3 (release 1.3.0) generic over language: the `language` field
 * carries the adapter id (e.g. 'typescript', 'python', 'rust') and
 * `cacheKey` is an opaque per-adapter invalidation string. The
 * pre-v3 fields `tsConfigPath` and `tsCompilerVersion` are gone
 * from the engine; v2 catalogs on disk classify as `invalid` at
 * load time.
 *
 * `cacheKey` is optional here because external callers parsing
 * a v2 catalog they have on disk would otherwise fail to load
 * the file with this type. Engine-internal code requires it.
 */
export interface GraphCatalog {
  readonly version: string;
  readonly tool: string;
  readonly language: string;
  readonly builtAt: string;
  readonly cacheKey?: string;
  readonly filesFingerprint?: string;
  /** The resolution tier that produced this catalog. Absent ⇒ `'exact'`
   *  (historical behavior). Mirrors the engine `Catalog.resolutionMode`. */
  readonly resolutionMode?: GraphResolutionMode;
  readonly functions: Readonly<Record<string, readonly GraphFunctionOccurrence[]>>;
}
