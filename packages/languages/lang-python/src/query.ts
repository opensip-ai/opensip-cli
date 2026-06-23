/**
 * Python {@link LanguageQueryAPI} (ADR-0010, M10) — the grammar config for the
 * shared `createTreeSitterQuery` factory. Node types are from tree-sitter-python;
 * the callee extractor mirrors `graph-python`'s resolver so the query agrees
 * with the call graph.
 */

import {
  createTreeSitterQuery,
  namedChildrenOf,
  type ExtractedImport,
  type LanguageQueryAPI,
  type Node,
  type ParsedFile,
} from '@opensip-cli/tree-sitter';

/** Leaf callee name of a `call` node (`foo()` → `foo`, `o.m()` → `m`). */
function calleeName(node: Node): string | null {
  const fn = node.childForFieldName('function');
  /* v8 ignore next -- a `call` node always exposes its `function` field */
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    /* v8 ignore next -- an attribute node always exposes its `attribute` field */
    return attr ? attr.text : null;
  }
  // Other callee shapes (subscript/computed) — unresolved by name.
  return null;
}

/** The terminal segment of a dotted module path (`a.b.c` → `c`). */
function dottedLeaf(text: string): string {
  /* v8 ignore next -- split('.') on a non-empty path always yields a segment */
  return text.split('.').pop() ?? text;
}

/** Resolve a name-bearing import item (identifier / dotted_name / aliased_import). */
function importItemName(node: Node): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'dotted_name') return dottedLeaf(node.text);
  if (node.type === 'aliased_import') {
    // `<path> as <alias>` — keep the underlying leaf name (alias dropped).
    const inner = node.childForFieldName('name') ?? node.namedChild(0);
    /* v8 ignore next -- an aliased_import always wraps a name node */
    return inner ? importItemName(inner) : null;
  }
  // Non-name children (e.g. comments inside a parenthesized import list).
  return null;
}

/**
 * Expand a Python import statement into import targets.
 *   - `import a.b.c`            → specifier `a.b.c`, names `[c]`
 *   - `import a.b as x`         → specifier `a.b`, names `[b]`
 *   - `from m import x, y`      → specifier `m`, names `[x, y]`
 *   - `from m import *`         → specifier `m`, names `[]`
 */
/** The path text of an import item — the LHS path of an `aliased_import`. */
function importItemSpecifier(item: Node): string {
  if (item.type === 'aliased_import') {
    const inner = item.childForFieldName('name') ?? item.namedChild(0);
    /* v8 ignore next -- an aliased_import always wraps a path node */
    return inner ? inner.text : item.text;
  }
  return item.text;
}

function extractImport(node: Node): readonly ExtractedImport[] {
  if (node.type === 'import_statement') {
    const out: ExtractedImport[] = [];
    for (const item of namedChildrenOf(node)) {
      const specifier = importItemSpecifier(item);
      const name = importItemName(item);
      out.push({ specifier, names: name ? [name] : [] });
    }
    return out;
  }
  // import_from_statement (the only other configured import node type).
  const moduleNode = node.childForFieldName('module_name');
  /* v8 ignore next -- a from-import always has a module_name (`.` for relatives) */
  const specifier = moduleNode ? moduleNode.text : '';
  const names: string[] = [];
  // Imported names are the name-bearing children other than the module
  // itself. A bare `*` (`wildcard_import`) contributes no names.
  for (const child of namedChildrenOf(node)) {
    if (child.startIndex === moduleNode?.startIndex) continue;
    if (child.type === 'wildcard_import') continue;
    const name = importItemName(child);
    if (name) names.push(name);
  }
  return [{ specifier, names }];
}

const FUNCTION_NODE_TYPES = new Set(['function_definition', 'lambda']);
const CALL_NODE_TYPES = new Set(['call']);
const IMPORT_NODE_TYPES = new Set(['import_statement', 'import_from_statement']);
const STRING_NODE_TYPES = new Set(['string']);

/** A `lambda` has no name field — keep `findFunctions` faithful (null). */
function pythonFunctionName(node: Node): string | null {
  if (node.type === 'lambda') return null;
  const name = node.childForFieldName('name');
  /* v8 ignore next -- a function_definition always exposes its name field */
  return name ? name.text : null;
}

export const pythonQuery: LanguageQueryAPI<ParsedFile, Node> = createTreeSitterQuery({
  functions: { nodeTypes: FUNCTION_NODE_TYPES, nameOf: pythonFunctionName },
  calls: { nodeTypes: CALL_NODE_TYPES, calleeName },
  imports: { nodeTypes: IMPORT_NODE_TYPES, extract: extractImport },
  strings: { nodeTypes: STRING_NODE_TYPES },
});
