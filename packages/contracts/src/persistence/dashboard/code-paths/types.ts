/**
 * Type-only structural shapes for the v0.3 Code Paths panel.
 *
 * The graph engine's catalog.json is consumed here purely by JSON shape;
 * this file MUST NOT import from `@opensip-tools/graph`. The shape is
 * intentionally duplicated as readonly structural types — see §2.4 of
 * docs/plans/graph-dashboard-v3-design.md (decoupling claim).
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
  | 'dynamic-string';

export type GraphCallConfidence = 'high' | 'medium' | 'low';

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
}

export interface GraphFunctionOccurrence {
  readonly bodyHash: string;
  readonly simpleName: string;
  readonly qualifiedName: string;
  readonly filePath: string;
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
  readonly functions: Readonly<Record<string, readonly GraphFunctionOccurrence[]>>;
}
