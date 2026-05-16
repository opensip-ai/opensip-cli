/**
 * Catalog data model — the durable artifact of the graph parse pass.
 *
 * Function nodes carry a hybrid id `fn:${contentHash}@${filePath}#${simpleName}`
 * (Appendix A of the design spec). The contentHash is sha256 of the function
 * body with whitespace collapsed; same body in two files joins on contentHash.
 * The full id is unique because filePath + simpleName tie-break duplicates.
 *
 * Outgoing edges live on `FunctionNode.calls`. An inverted index (callers)
 * is rebuilt globally on every run — see `buildIndexes`. Polymorphic dispatch
 * fans out: a single CallSite has multiple `resolvedTo` ids, and every target
 * gets the call source recorded as a (potential) caller.
 */

/** Schema version of the on-disk catalog file. Bump on breaking format changes. */
export const CATALOG_VERSION = '1.0' as const;

/** Tool tag stored in the catalog file so consumers can sanity-check it. */
export const CATALOG_TOOL = 'graph' as const;

/** Language the catalog covers. v1 is TypeScript-only. */
export const CATALOG_LANGUAGE = 'typescript' as const;

/**
 * 8-kind side-effect taxonomy. Populated lazily — null until a rule that
 * needs side-effect info computes it. P0–P3 leave this null everywhere;
 * P4 wires up the detector.
 */
export type SideEffectKind =
  | 'io.fs'
  | 'io.network'
  | 'io.process'
  | 'database'
  | 'logging'
  | 'state.module'
  | 'state.global'
  | 'control.throw';

/** How a call site was resolved. See spec §3 for the dispatch ladder. */
export type CallResolution =
  /** Direct call where the TypeChecker pinned a single declaration. */
  | 'static'
  /** Method dispatch via interface/abstract class — N candidates. */
  | 'method-dispatch'
  /** TypeChecker had no symbol, type was `any`/`unknown`, or assertion stripped it. */
  | 'unknown'
  /** Runtime-only callee: `obj[name]()`, `bus.emit('foo')`, etc. */
  | 'dynamic-string';

/** Resolver's confidence in a call site's resolvedTo set. */
export type CallConfidence = 'high' | 'medium' | 'low';

/** Visibility classification for a function node. */
export type FunctionVisibility = 'exported' | 'module-local' | 'private';

/** Discriminator for what kind of declaration produced this function node. */
export type FunctionKind = 'function' | 'method' | 'arrow' | 'constructor' | 'getter' | 'setter';

/** A formal parameter on a FunctionNode signature. */
export interface FunctionParam {
  readonly name: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** A single call site inside a FunctionNode body. */
export interface CallSite {
  readonly line: number;
  readonly column: number;
  /**
   * FunctionNode.id values this call may dispatch to. Multiple = polymorphic.
   * Empty array is permitted when resolution is 'unknown' or 'dynamic-string'.
   */
  readonly resolvedTo: readonly string[];
  readonly resolution: CallResolution;
  readonly confidence: CallConfidence;
  /** The raw call expression text — useful for reporting and debugging. */
  readonly text: string;
}

/** A single function definition reachable in the catalog. */
export interface FunctionNode {
  /** Hybrid id: `fn:${contentHash}@${filePath}#${simpleName}` (Appendix A). */
  readonly id: string;
  /** Dotted/rooted name used in display: `core/lib/paths.resolveProjectPaths`. */
  readonly qualifiedName: string;
  /** Function name as it appears in source (or `<anonymous>` / `<arrow>` synthesized). */
  readonly simpleName: string;

  /** Path relative to the catalog's project root. */
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;

  readonly kind: FunctionKind;
  readonly params: readonly FunctionParam[];
  readonly returnType?: string;

  /** File this function is exported from (often === filePath). */
  readonly exportedFrom?: string;
  readonly visibility: FunctionVisibility;
  readonly enclosingClass?: string;
  readonly decorators: readonly string[];

  /** Side-effect kinds detected directly inside this function body. Null until P4. */
  readonly directSideEffects: readonly SideEffectKind[] | null;

  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;

  /** Outgoing edges from this function. */
  readonly calls: readonly CallSite[];
}

/** A file the catalog walked. */
export interface FileNode {
  readonly path: string;
  /** Sha-256 of the file contents (hex). */
  readonly contentHash: string;
  readonly languageId: 'typescript';
  readonly inTestPath: boolean;
  readonly imports: readonly FileImport[];
  /** FunctionNode.id values defined in this file. */
  readonly definesFunctions: readonly string[];
}

/** A single `import` statement on a file. */
export interface FileImport {
  readonly specifier: string;
  /** Resolved absolute path of the imported module, or null if unresolvable. */
  readonly resolvedPath: string | null;
  readonly imported: readonly { local: string; external: string }[];
}

/**
 * Cross-cutting indexes built from the FunctionNode list. Always rebuilt
 * globally — never persisted incrementally — because index staleness would
 * silently break the orphan classification.
 */
export interface CatalogIndex {
  /** content-hash → FunctionNode.id values (duplicate-body join key). */
  readonly byContentHash: ReadonlyMap<string, readonly string[]>;
  /** FunctionNode.id → ids of FunctionNodes that call it. */
  readonly callers: ReadonlyMap<string, readonly string[]>;
}

/** The full v1 catalog as serialized on disk. */
export interface CatalogV1 {
  readonly version: typeof CATALOG_VERSION;
  readonly tool: typeof CATALOG_TOOL;
  readonly language: typeof CATALOG_LANGUAGE;
  /** ISO timestamp of when this catalog was built. */
  readonly builtAt: string;
  /** Resolved tsconfig path used for module resolution. */
  readonly tsConfigPath: string;
  /** TypeScript compiler version at build time. */
  readonly tsCompilerVersion: string;
  readonly files: readonly FileNode[];
  readonly functions: readonly FunctionNode[];
  /**
   * Persisted form of CatalogIndex. Maps are turned into plain objects
   * so JSON round-tripping doesn't lose data.
   */
  readonly indexes: {
    readonly byContentHash: Readonly<Record<string, readonly string[]>>;
    readonly callers: Readonly<Record<string, readonly string[]>>;
  };
}

/** In-memory shape produced by the builder — same data, with ReadonlyMap indexes. */
export interface Catalog {
  readonly version: typeof CATALOG_VERSION;
  readonly tool: typeof CATALOG_TOOL;
  readonly language: typeof CATALOG_LANGUAGE;
  readonly builtAt: string;
  readonly tsConfigPath: string;
  readonly tsCompilerVersion: string;
  readonly files: readonly FileNode[];
  readonly functions: readonly FunctionNode[];
  readonly indexes: CatalogIndex;
}
