// @fitness-ignore-file duplicate-utility-functions -- ADR-0010/M10: the per-language tree-sitter query config intentionally shares helper names (callee/import/string extractors) across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * Java {@link LanguageQueryAPI} (ADR-0010, M10) — the grammar config for the
 * shared `createTreeSitterQuery` factory. Node types are from tree-sitter-java;
 * the callee extractor mirrors `graph-java`'s resolver.
 *
 * A Java `import a.b.C;` imports the single type `C` by its fully-qualified
 * path, so `findImports` reports specifier `a.b.C` with name `[C]`. A
 * wildcard `import a.b.*;` imports a whole package (no single named type), so
 * names is empty — the faithful equivalent.
 */

import {
  createTreeSitterQuery,
  type ExtractedImport,
  type LanguageQueryAPI,
  type Node,
  type ParsedFile,
} from '@opensip-cli/tree-sitter';

/** Leaf callee name of a `method_invocation` / `object_creation_expression`. */
function calleeName(node: Node): string | null {
  if (node.type === 'method_invocation') {
    const name = node.childForFieldName('name');
    /* v8 ignore next -- a method_invocation always exposes its `name` field */
    return name ? name.text : null;
  }
  // object_creation_expression (the only other configured call node type).
  const ty = node.childForFieldName('type');
  /* v8 ignore next -- `new T(...)` always exposes its `type` field */
  return ty ? leafTypeName(ty) : null;
}

/** Terminal name of a (possibly generic / qualified) type node. */
function leafTypeName(node: Node): string | null {
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'generic_type') {
    // `ArrayList<String>` → first named child is the raw `type_identifier`.
    const inner = node.namedChild(0);
    /* v8 ignore next -- a generic_type always wraps a raw type node */
    return inner ? leafTypeName(inner) : null;
  }
  if (node.type === 'scoped_type_identifier') {
    // `a.b.C` → last named child is the terminal type name.
    const inner = node.namedChild(node.namedChildCount - 1);
    /* v8 ignore next -- a scoped_type_identifier always has a terminal name */
    return inner ? leafTypeName(inner) : null;
  }
  return node.text;
}

/** Terminal segment of a dotted import path (`a.b.C` → `C`). */
function dottedLeaf(text: string): string {
  /* v8 ignore next -- split('.') on a non-empty path always yields a segment */
  return text.split('.').pop() ?? text;
}

/**
 * Expand an `import_declaration` into a single import target.
 *   - `import a.b.C;`  → specifier `a.b.C`, names `[C]`
 *   - `import a.b.*;`  → specifier `a.b.*`, names `[]`
 *   - `import static a.b.C.m;` → specifier `a.b.C.m`, names `[m]`
 */
function extractImport(node: Node): readonly ExtractedImport[] {
  const path = node.childForFieldName('name') ?? firstScopedIdentifier(node);
  /* v8 ignore next -- an import_declaration always has a path */
  if (!path) return [];
  const hasAsterisk = node.children.some((c) => c !== null && c.type === 'asterisk');
  const base = path.text;
  if (hasAsterisk) return [{ specifier: `${base}.*`, names: [] }];
  return [{ specifier: base, names: [dottedLeaf(base)] }];
}

/* v8 ignore start -- defensive fallback: import_declaration always exposes the
   `name` field, so this scan only runs on a malformed/partial tree */
function firstScopedIdentifier(node: Node): Node | null {
  for (const c of node.namedChildren) {
    if (c && (c.type === 'scoped_identifier' || c.type === 'identifier')) return c;
  }
  return null;
}
/* v8 ignore stop */

const FUNCTION_NODE_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'lambda_expression',
]);
const CALL_NODE_TYPES = new Set(['method_invocation', 'object_creation_expression']);
const IMPORT_NODE_TYPES = new Set(['import_declaration']);
const STRING_NODE_TYPES = new Set(['string_literal']);

/** A `lambda_expression` has no name field — keep `findFunctions` faithful. */
function javaFunctionName(node: Node): string | null {
  if (node.type === 'lambda_expression') return null;
  const name = node.childForFieldName('name');
  /* v8 ignore next -- method/constructor declarations always expose a name field */
  return name ? name.text : null;
}

export const javaQuery: LanguageQueryAPI<ParsedFile, Node> = createTreeSitterQuery({
  functions: { nodeTypes: FUNCTION_NODE_TYPES, nameOf: javaFunctionName },
  calls: { nodeTypes: CALL_NODE_TYPES, calleeName },
  imports: { nodeTypes: IMPORT_NODE_TYPES, extract: extractImport },
  strings: { nodeTypes: STRING_NODE_TYPES },
});
