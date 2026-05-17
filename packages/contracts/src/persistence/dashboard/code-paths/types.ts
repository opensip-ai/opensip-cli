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

export interface GraphCatalog {
  readonly version: string;
  readonly tool: string;
  readonly language: string;
  readonly builtAt: string;
  readonly tsConfigPath?: string;
  readonly tsCompilerVersion?: string;
  readonly filesFingerprint?: string;
  readonly functions: Readonly<Record<string, readonly GraphFunctionOccurrence[]>>;
}
