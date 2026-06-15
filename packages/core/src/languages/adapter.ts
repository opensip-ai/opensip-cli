import type { GenericFunction, Import, Location } from './generic-types.js';
import type { WorkspaceUnit } from './workspace-unit.js';

/**
 * Minimal cross-language query primitives. Each adapter implements
 * whichever of these it can support efficiently.
 */
export interface LanguageQueryAPI<TTree, TNode> {
  findFunctions(tree: TTree): readonly GenericFunction<TNode>[];
  findImports(tree: TTree): readonly Import[];
  findCallsTo(tree: TTree, name: string): readonly TNode[];
  findStringLiterals(
    tree: TTree,
  ): readonly { readonly value: string; readonly location: Location }[];
  getLocation(tree: TTree, node: TNode): Location;
  getText(tree: TTree, node: TNode): string;
}

/**
 * A LanguageAdapter is the contract that every language pack implements.
 * TTree/TNode are opaque to core — passed through to checks.
 */
export interface LanguageAdapter<TTree = unknown, TNode = unknown> {
  /** Stable identifier matched against scope.languages in checks and languages: in targets. */
  readonly id: string;
  /** Lowercase extensions including the leading dot, e.g. ['.rs'] or ['.ts', '.tsx']. */
  readonly fileExtensions: readonly string[];
  /**
   * Optional aliases — e.g. `['rs']` for Rust, `['c']` for the cpp
   * adapter. The registry indexes these alongside `id` and consults
   * them through {@link LanguageRegistry.canonicalize}, so a target
   * declared with `languages: ['c']` matches a check scoped to `cpp`.
   */
  readonly aliases?: readonly string[];

  /** Parse a file's text into the adapter's native tree. Returns null on parse failure. */
  parse(content: string, filePath: string): TTree | null;

  /** Replace string literal content with whitespace of equal length. */
  stripStrings(content: string): string;

  /** Replace both string literals AND comments with whitespace of equal length. */
  stripComments(content: string): string;

  /** Optional generic query layer for cross-language checks. */
  readonly query?: LanguageQueryAPI<TTree, TNode>;

  /**
   * Optional async warmup (e.g. for tree-sitter WASM init). Reserved on the
   * contract for adapters that need a one-time async init pass. No bundled
   * adapter declares it today and the CLI bootstrap does NOT invoke it yet —
   * treat it as forward-compatible: a future adapter can opt in without a
   * contract change.
   */
  warmup?(): Promise<void>;

  /**
   * Optional workspace discovery. When implemented, returns the units
   * the `graph --workspace` fan-out should target — one TS package per
   * tsconfig.json, one Cargo member per `[workspace.members]` entry, etc.
   *
   * Adapters that have no workspace concept (or haven't implemented this
   * yet) omit the method; the CLI treats absence as an empty list. If
   * every detected adapter omits it AND the user passes `--workspace`,
   * the CLI errors with a message naming the language(s).
   *
   * `rootDir` is the absolute project root (the CLI's `--cwd` or
   * detection root). Implementations MUST return absolute paths in
   * `rootDir`; relative paths break the spawn step downstream.
   */
  discoverWorkspaceUnits?(rootDir: string): Promise<readonly WorkspaceUnit[]>;
}
