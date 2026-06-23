/**
 * Rust {@link LanguageQueryAPI} (ADR-0010, M10) — the grammar config for the
 * shared `createTreeSitterQuery` factory. Node types are from tree-sitter-rust;
 * the callee/import extractors mirror `graph-rust`'s resolver + use-declaration
 * walker so the query agrees with the call graph. The `/* v8 ignore *\/`
 * markers follow the graph adapters' convention: they guard AST shapes that
 * only a malformed/partial tree (error recovery) produces, which well-formed
 * Rust source never reaches.
 */

import {
  createTreeSitterQuery,
  namedChildrenOf,
  type ExtractedImport,
  type LanguageQueryAPI,
  type Node,
  type ParsedFile,
} from '@opensip-cli/tree-sitter';

/** Leaf callee name of a `call_expression` / `macro_invocation`. */
function calleeName(node: Node): string | null {
  if (node.type === 'macro_invocation') {
    const m = node.childForFieldName('macro') ?? node.namedChild(0);
    /* v8 ignore next -- a macro_invocation always exposes its macro path */
    if (!m) return null;
    return m.text.split('::').pop() ?? m.text;
  }
  const fn = node.childForFieldName('function');
  /* v8 ignore next -- a call_expression always exposes its `function` field */
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    return field ? field.text : null;
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name') ?? fn.namedChild(fn.namedChildCount - 1);
    return name ? name.text : null;
  }
  // Other callee shapes (index/closure/parenthesized) — unresolved by name.
  return null;
}

/** The `::`-joined segments of a path-bearing node, or null for unknown shapes. */
function pathText(node: Node): string | null {
  if (
    node.type === 'identifier' ||
    node.type === 'crate' ||
    node.type === 'super' ||
    node.type === 'self' ||
    node.type === 'scoped_identifier'
  ) {
    return node.text;
  }
  return null;
}

/** Last `::` segment of a path string — the "named import" for the SPI. */
function leafName(path: string): string {
  return path.split('::').pop() ?? path;
}

/**
 * Expand a `use_declaration` / `extern_crate_declaration` into import targets.
 * `use a::b::{x, y}` → specifier `a::b`, names `[x, y]`. A single path
 * (`use a::b::C`) → specifier `a::b::C`, names `[C]`. Wildcards/aliases keep the
 * underlying path and use the terminal segment as the name.
 */
function extractImport(node: Node): readonly ExtractedImport[] {
  if (node.type === 'extern_crate_declaration') {
    for (const c of namedChildrenOf(node)) {
      if (c.type === 'identifier') return [{ specifier: c.text, names: [c.text] }];
    }
    /* v8 ignore next -- extern_crate always has the crate identifier */
    return [];
  }
  // use_declaration: take the last non-visibility named child as the path body.
  let body: Node | null = null;
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (c && c.type !== 'visibility_modifier') {
      body = c;
      break;
    }
  }
  /* v8 ignore next -- a use_declaration always has a path-bearing body */
  if (!body) return [];
  return expandUseTree(body, '');
}

/** Join a path prefix and a segment with `::`, dropping empty parts. */
function joinPath(prefix: string, segment: string): string {
  if (!prefix) return segment;
  if (!segment) return prefix;
  return `${prefix}::${segment}`;
}

/**
 * Single self-recursive walker over a `use`-tree node. Mirrors the Rust
 * grammar's nesting (`use a::{b, c::{d}}`) by dispatching on the node type and
 * recursing into list items / aliased inner paths with the accumulated `prefix`:
 *
 *   - simple path (`identifier`/`crate`/`super`/`self`/`scoped_identifier`)
 *     → one import `prefix::<path>` named by its terminal segment.
 *   - `use_as_clause` (`p as q`) → recurse into the underlying path (the alias
 *     name is dropped; the terminal segment of the path is the import name).
 *   - `use_wildcard` (`p::*`) → one glob import with no names.
 *   - `scoped_use_list` (`p::{…}`) → recurse each list item under `prefix::p`.
 *   - bare `use_list` (`{…}`) → recurse each list item under `prefix`.
 *   - `self` AS A LIST ITEM refers to the enclosing prefix path itself.
 *
 * Consolidated from the former mutual recursion (`expandUseSegment` ↔
 * `expandScopedUseList` ↔ `expandUseListItems`) into one function so the static
 * call graph sees a single self-recursive walker (no inter-function cycle); the
 * behaviour is byte-identical.
 */
function expandUseTree(node: Node, prefix: string): readonly ExtractedImport[] {
  const join = (seg: string): string => (prefix ? `${prefix}::${seg}` : seg);

  const simple = pathText(node);
  if (simple !== null) {
    const full = join(simple);
    return [{ specifier: full, names: [leafName(full)] }];
  }

  if (node.type === 'use_as_clause') {
    const inner = node.namedChild(0);
    /* v8 ignore next -- a use_as_clause always wraps a path node */
    return inner ? expandUseTree(inner, prefix) : [];
  }

  if (node.type === 'use_wildcard') {
    const inner = node.namedChild(0);
    const base = inner ? pathText(inner) : null;
    const full = base === null ? join('*') : `${join(base)}::*`;
    return [{ specifier: full, names: [] }];
  }

  // Both list shapes resolve to (a `use_list` node, the prefix its items extend)
  // and then iterate those items — recursing into each via this same walker.
  // `scoped_use_list` (`p::{…}`) carries a path segment ahead of its list, so its
  // items extend `prefix::p`; a bare `use_list` (`{…}`) extends `prefix` unchanged.
  // The list iteration is inlined (no helper) so the call graph sees ONE
  // self-recursive walker rather than the former mutual recursion.
  const { list, listPrefix } = resolveUseList(node, prefix);
  if (!list) return [];

  // `self` AS A LIST ITEM refers to the enclosing prefix path itself
  // (`use a::{self}` → import `a`); every other item recurses under `listPrefix`.
  const out: ExtractedImport[] = [];
  for (const item of namedChildrenOf(list)) {
    if (item.type === 'self') {
      out.push({ specifier: listPrefix, names: [leafName(listPrefix)] });
      continue;
    }
    out.push(...expandUseTree(item, listPrefix));
  }
  return out;
}

/**
 * Resolve a use-tree node to its `use_list` and the prefix that list's items
 * extend, or `{ list: null }` for a non-list node. Split out (a pure node→data
 * helper that does NOT recurse) so {@link expandUseTree} stays a single
 * self-recursive walker with no cross-function cycle.
 */
function resolveUseList(node: Node, prefix: string): { list: Node | null; listPrefix: string } {
  if (node.type === 'scoped_use_list') {
    let pathSeg = '';
    let list: Node | null = null;
    for (const c of namedChildrenOf(node)) {
      if (c.type === 'use_list') list = c;
      else if (list === null) pathSeg = pathText(c) ?? '';
    }
    /* v8 ignore next -- a scoped_use_list always contains its use_list */
    if (!list) return { list: null, listPrefix: prefix };
    return { list, listPrefix: joinPath(prefix, pathSeg) };
  }
  /* v8 ignore next 3 -- a bare top-level use_list (or any other shape) is not
     produced for well-formed source the walker reaches */
  if (node.type === 'use_list') {
    return { list: node, listPrefix: prefix };
  }
  return { list: null, listPrefix: prefix };
}

const FUNCTION_NODE_TYPES = new Set(['function_item', 'closure_expression']);
const CALL_NODE_TYPES = new Set(['call_expression', 'macro_invocation']);
const IMPORT_NODE_TYPES = new Set(['use_declaration', 'extern_crate_declaration']);
const STRING_NODE_TYPES = new Set(['string_literal', 'raw_string_literal']);

/** A `closure_expression` has no name field — keep `findFunctions` faithful. */
function rustFunctionName(node: Node): string | null {
  if (node.type === 'closure_expression') return null;
  const name = node.childForFieldName('name');
  /* v8 ignore next -- a function_item always exposes its name field */
  return name ? name.text : null;
}

export const rustQuery: LanguageQueryAPI<ParsedFile, Node> = createTreeSitterQuery({
  functions: { nodeTypes: FUNCTION_NODE_TYPES, nameOf: rustFunctionName },
  calls: { nodeTypes: CALL_NODE_TYPES, calleeName },
  imports: { nodeTypes: IMPORT_NODE_TYPES, extract: extractImport },
  strings: { nodeTypes: STRING_NODE_TYPES },
});
