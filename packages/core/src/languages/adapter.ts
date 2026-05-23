import type { GenericFunction, Import, Location } from './generic-types.js'

/**
 * Minimal cross-language query primitives. Each adapter implements
 * whichever of these it can support efficiently.
 */
export interface LanguageQueryAPI<TTree, TNode> {
  findFunctions(tree: TTree): readonly GenericFunction<TNode>[]
  findImports(tree: TTree): readonly Import[]
  findCallsTo(tree: TTree, name: string): readonly TNode[]
  findStringLiterals(tree: TTree): readonly { readonly value: string; readonly location: Location }[]
  getLocation(tree: TTree, node: TNode): Location
  getText(tree: TTree, node: TNode): string
}

/**
 * A LanguageAdapter is the contract that every language pack implements.
 * TTree/TNode are opaque to core — passed through to checks.
 */
export interface LanguageAdapter<TTree = unknown, TNode = unknown> {
  /** Stable identifier matched against scope.languages in checks and languages: in targets. */
  readonly id: string
  /** Lowercase extensions including the leading dot, e.g. ['.rs'] or ['.ts', '.tsx']. */
  readonly fileExtensions: readonly string[]
  /**
   * Optional aliases — e.g. `['rs']` for Rust, `['c']` for the cpp
   * adapter. The registry indexes these alongside `id` and consults
   * them through {@link LanguageRegistry.canonicalize}, so a target
   * declared with `languages: ['c']` matches a check scoped to `cpp`.
   */
  readonly aliases?: readonly string[]

  /** Parse a file's text into the adapter's native tree. Returns null on parse failure. */
  parse(content: string, filePath: string): TTree | null

  /** Replace string literal content with whitespace of equal length. */
  stripStrings(content: string): string

  /** Replace both string literals AND comments with whitespace of equal length. */
  stripComments(content: string): string

  /** Optional generic query layer for cross-language checks. */
  readonly query?: LanguageQueryAPI<TTree, TNode>

  /** Optional async warmup (e.g. for tree-sitter WASM init). Called by CLI bootstrap. */
  warmup?(): Promise<void>
}
