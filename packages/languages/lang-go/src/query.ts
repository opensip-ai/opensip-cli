/**
 * Go {@link LanguageQueryAPI} (ADR-0010, M10) — the grammar config for the
 * shared `createTreeSitterQuery` factory. Node types are from tree-sitter-go;
 * the callee/import extractors mirror `graph-go`'s resolver + import walker so
 * the query agrees with the call graph.
 *
 * Go has no named-import concept (a package is imported whole by path), so
 * `findImports` returns `names: []` — the faithful equivalent, not a gap.
 */

import {
  createTreeSitterQuery,
  namedChildrenOf,
  type ExtractedImport,
  type LanguageQueryAPI,
  type Node,
  type ParsedFile,
} from '@opensip-cli/tree-sitter';

/** Leaf callee name of a `call_expression` (`foo()` → `foo`, `p.F()` → `F`). */
function calleeName(node: Node): string | null {
  const fn = node.childForFieldName('function');
  /* v8 ignore next -- a call_expression always exposes its `function` field */
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    /* v8 ignore next -- a selector_expression always exposes its `field` */
    return field ? field.text : null;
  }
  // Other callee shapes (index/type-assertion calls) — unresolved by name.
  return null;
}

/** Unwrap a Go interpreted-string literal (`"fmt"` → `fmt`), or null. */
function unquote(text: string): string | null {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  /* v8 ignore next -- Go import paths are always quoted interpreted strings */
  return null;
}

/**
 * Expand an `import_declaration` into import targets — one per `import_spec`,
 * single (`import "fmt"`) or grouped (`import ( … )`). Names are always empty
 * (Go imports a package whole). Aliased/blank/dot imports keep the path.
 */
function extractImport(node: Node): readonly ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const child of namedChildrenOf(node)) {
    if (child.type === 'import_spec') {
      pushSpec(child, out);
    } else if (child.type === 'import_spec_list') {
      for (const spec of namedChildrenOf(child)) {
        if (spec.type === 'import_spec') pushSpec(spec, out);
      }
    }
  }
  return out;
}

function pushSpec(spec: Node, out: ExtractedImport[]): void {
  const pathNode = spec.childForFieldName('path') ?? findInterpretedString(spec);
  /* v8 ignore next -- an import_spec always has a path */
  if (!pathNode) return;
  const specifier = unquote(pathNode.text);
  /* v8 ignore next -- unquote never returns null for a Go import path */
  if (specifier === null) return;
  out.push({ specifier, names: [] });
}

/* v8 ignore start -- defensive fallback: import_spec always exposes the `path`
   field, so this scan only runs on a malformed/partial tree */
function findInterpretedString(node: Node): Node | null {
  for (const child of namedChildrenOf(node)) {
    if (child.type === 'interpreted_string_literal') return child;
  }
  return null;
}
/* v8 ignore stop */

const FUNCTION_NODE_TYPES = new Set(['function_declaration', 'method_declaration', 'func_literal']);
const CALL_NODE_TYPES = new Set(['call_expression']);
const IMPORT_NODE_TYPES = new Set(['import_declaration']);
const STRING_NODE_TYPES = new Set(['interpreted_string_literal', 'raw_string_literal']);

/** A `func_literal` has no name field — keep `findFunctions` faithful (null). */
function goFunctionName(node: Node): string | null {
  if (node.type === 'func_literal') return null;
  const name = node.childForFieldName('name');
  /* v8 ignore next -- function/method declarations always expose a name field */
  return name ? name.text : null;
}

export const goQuery: LanguageQueryAPI<ParsedFile, Node> = createTreeSitterQuery({
  functions: { nodeTypes: FUNCTION_NODE_TYPES, nameOf: goFunctionName },
  calls: { nodeTypes: CALL_NODE_TYPES, calleeName },
  imports: { nodeTypes: IMPORT_NODE_TYPES, extract: extractImport },
  strings: { nodeTypes: STRING_NODE_TYPES },
});
