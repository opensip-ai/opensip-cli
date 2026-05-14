/** Shared types used by the cross-language query API. */

export interface Location {
  readonly file: string
  readonly line: number      // 1-based
  readonly column: number    // 0-based
}

export interface Import {
  /** The import specifier as written in source (e.g. './foo', 'std::fs', '"fmt"') */
  readonly specifier: string
  /** Imported names where the language supports named imports; empty otherwise */
  readonly names: readonly string[]
  readonly location: Location
}

export interface GenericFunction<TNode> {
  readonly name: string | null  // null for anonymous / lambdas
  readonly location: Location
  /** The native AST node, opaque to core */
  readonly node: TNode
}
