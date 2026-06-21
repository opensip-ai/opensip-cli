/**
 * `createTreeSitterQuery` — the shared, grammar-agnostic implementation of
 * core's {@link LanguageQueryAPI} for every tree-sitter `lang-*` adapter
 * (ADR-0010, M10). The traversal is written once here; each adapter supplies a
 * tiny {@link TreeSitterQueryConfig} naming its grammar's node types plus the
 * handful of extractors a grammar genuinely differs on (callee name, import
 * shape, string value).
 *
 * The query operates over the adapter's parse result — a {@link ParsedFile}
 * (`{ tree, source }`), the same value `adapter.parse()` returns — so it slots
 * straight onto `LanguageAdapter<ParsedFile, Node>.query` exactly the way
 * `typescriptQuery` slots onto `LanguageAdapter<ts.SourceFile, ts.Node>`.
 *
 * The semantics mirror `lang-typescript`'s reference `typescriptQuery` so the
 * equivalence cross-language checks expect holds:
 *
 *   - `findFunctions`     — every function/method/lambda declaration node,
 *                           `name` via the grammar `name` field (`null` for
 *                           anonymous lambdas/closures), matching TS's mix of
 *                           function declarations + arrow/method nodes.
 *   - `findImports`       — one {@link Import} per import target. `names` is
 *                           populated where the grammar exposes named imports
 *                           (Rust `use a::{x, y}`, Python `from m import x`);
 *                           empty where the language has no named-import concept
 *                           (Go/Java import a whole package/type by path — the
 *                           faithful equivalent, not a silent gap).
 *   - `findCallsTo`       — call/macro/invocation nodes whose *leaf* callee name
 *                           equals `name` (the same leaf-name match TS uses for
 *                           `foo()` and `obj.bar()`), via the per-grammar
 *                           `calleeName` extractor.
 *   - `findStringLiterals`— every string-literal node, value via the per-grammar
 *                           `stringValue` extractor (default strips one matching
 *                           pair of surrounding quotes).
 *   - `getLocation` / `getText` — `{ file, line(1-based), column(0-based) }` and
 *                           `node.text`, matching the TS shapes.
 *
 * Faithful-equivalent note: a tree-sitter `Tree` carries no source filename
 * (unlike a `ts.SourceFile`, whose `fileName` `typescriptQuery` uses), so
 * `Location.file` is the empty string. Cross-language checks key on
 * `line`/`column`/`value`, not on `file`.
 *
 * Traversal uses the package's {@link walkNodes} (named descendants only —
 * punctuation/anonymous tokens are never functions, calls, imports, or string
 * literals, so visiting them would only waste cycles).
 */

import { getColumn, getLineNumber, nameOf, walkNodes } from './nodes.js';

import type { Node, ParsedFile } from './types.js';
import type {
  GenericFunction,
  Import,
  LanguageQueryAPI,
  Location,
} from '@opensip-cli/core/languages';

// Re-export the SPI surface so tree-sitter `lang-*` adapters reach the query
// contract THROUGH the substrate (the same way they reach Node/ParsedFile),
// without an extra direct dependency edge on @opensip-cli/core for the type.
export type {
  GenericFunction,
  Import,
  LanguageQueryAPI,
  Location,
} from '@opensip-cli/core/languages';

/**
 * One import target extracted from an import-declaration node. A single node
 * can yield several (e.g. Go's grouped `import ( … )`, Rust's `use a::{x, y}`),
 * so {@link TreeSitterQueryConfig.imports.extract} returns an array.
 */
export interface ExtractedImport {
  /** The import specifier as written (module path / crate path), no quotes. */
  readonly specifier: string;
  /** Named imports where the grammar supports them; empty otherwise. */
  readonly names: readonly string[];
}

/** Per-language grammar configuration for {@link createTreeSitterQuery}. */
export interface TreeSitterQueryConfig {
  readonly functions: {
    /** Grammar node types that declare a callable (function/method/lambda). */
    readonly nodeTypes: ReadonlySet<string>;
    /**
     * The declared name of a function node, or `null` for anonymous shapes.
     * Defaults to {@link nameOf} (reads the grammar `name` field).
     */
    readonly nameOf?: (node: Node) => string | null;
  };
  readonly calls: {
    /** Grammar node types for a call/invocation (call_expression, call, …). */
    readonly nodeTypes: ReadonlySet<string>;
    /**
     * The leaf callee name of a call node, or `null` when the shape isn't a
     * simple named call (e.g. an index/computed callee). Mirrors each graph
     * adapter's `extractCallTargetName`.
     */
    readonly calleeName: (node: Node) => string | null;
  };
  readonly imports: {
    /** Grammar node types for an import/use declaration. */
    readonly nodeTypes: ReadonlySet<string>;
    /** Expand one import-declaration node into zero or more import targets. */
    readonly extract: (node: Node) => readonly ExtractedImport[];
  };
  readonly strings: {
    /** Grammar node types for a string literal. */
    readonly nodeTypes: ReadonlySet<string>;
    /**
     * The literal's value. Defaults to {@link stripSurroundingQuotes} over
     * `node.text` (handles the common `"…"` / `'…'` / backtick cases).
     * Named `stringValue` (not `valueOf`) to avoid colliding with
     * `Object.prototype.valueOf` in structural assignability.
     */
    readonly stringValue?: (node: Node) => string;
  };
}

/** Strip one matched pair of surrounding `"`, `'`, or backtick quotes. */
export function stripSurroundingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text.at(-1);
    if ((first === '"' || first === "'" || first === '`') && last === first) {
      return text.slice(1, -1);
    }
  }
  return text;
}

// tree-sitter trees carry no source path; Location.file is empty (see the
// factory docstring). Checks key on line/column/value, not file.
const NO_FILE = '';

function locationOf(node: Node): Location {
  return { file: NO_FILE, line: getLineNumber(node), column: getColumn(node) };
}

/**
 * Build a {@link LanguageQueryAPI} over a {@link ParsedFile} from a per-language
 * {@link TreeSitterQueryConfig}. The result is assignable to
 * `LanguageAdapter<ParsedFile, Node>.query`.
 */
export function createTreeSitterQuery(
  config: TreeSitterQueryConfig,
): LanguageQueryAPI<ParsedFile, Node> {
  const functionName = config.functions.nameOf ?? nameOf;
  const stringValue =
    config.strings.stringValue ?? ((node: Node) => stripSurroundingQuotes(node.text));

  return {
    findFunctions(tree) {
      const out: GenericFunction<Node>[] = [];
      walkNodes(tree.tree.rootNode, (node) => {
        if (config.functions.nodeTypes.has(node.type)) {
          out.push({ name: functionName(node), location: locationOf(node), node });
        }
      });
      return out;
    },
    findImports(tree) {
      const out: Import[] = [];
      walkNodes(tree.tree.rootNode, (node) => {
        if (!config.imports.nodeTypes.has(node.type)) return;
        const location = locationOf(node);
        for (const imp of config.imports.extract(node)) {
          out.push({ specifier: imp.specifier, names: imp.names, location });
        }
      });
      return out;
    },
    findCallsTo(tree, name) {
      const out: Node[] = [];
      walkNodes(tree.tree.rootNode, (node) => {
        if (config.calls.nodeTypes.has(node.type) && config.calls.calleeName(node) === name) {
          out.push(node);
        }
      });
      return out;
    },
    findStringLiterals(tree) {
      const out: { value: string; location: Location }[] = [];
      walkNodes(tree.tree.rootNode, (node) => {
        if (config.strings.nodeTypes.has(node.type)) {
          out.push({ value: stringValue(node), location: locationOf(node) });
        }
      });
      return out;
    },
    getLocation(_tree, node) {
      return locationOf(node);
    },
    getText(_tree, node) {
      return node.text;
    },
  };
}
