/**
 * Rust `use` / `extern crate` dependency-site collection for the walker.
 */

import { namedChildrenOf } from '@opensip-cli/graph-adapter-common';

import type { RustParsedFile } from './parse.js';
import type { DependencySiteRecord } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

interface UseSiteContext {
  readonly file: RustParsedFile;
  readonly ownerHash: string;
  readonly line: number;
  readonly column: number;
}

/** Walk top-level `use` and `extern crate` declarations as dependency sites. */
export function collectDependencySites(
  file: RustParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of namedChildrenOf(file.tree.rootNode)) {
    if (stmt.type === 'use_declaration') {
      collectFromUseDeclaration(stmt, file, moduleInitHash, out);
    } else if (stmt.type === 'extern_crate_declaration') {
      collectFromExternCrate(stmt, file, moduleInitHash, out);
    }
  }
}

function collectFromUseDeclaration(
  decl: Node,
  file: RustParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  const body = pickUsePathNode(decl);
  if (!body) return;
  const ctx: UseSiteContext = {
    file,
    ownerHash,
    line: decl.startPosition.row + 1,
    column: decl.startPosition.column,
  };
  emitFromUseSegment(body, [], ctx, out);
}

function pickUsePathNode(decl: Node): Node | null {
  for (let i = decl.namedChildCount - 1; i >= 0; i--) {
    const c = decl.namedChild(i);
    if (!c) continue;
    if (c.type === 'visibility_modifier') continue;
    return c;
  }
  /* v8 ignore next */
  return null;
}

function emitFromUseSegment(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  switch (node.type) {
    case 'scoped_identifier':
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self': {
      emitFromPathLeaf(node, prefix, ctx, out);
      return;
    }
    case 'use_as_clause': {
      emitFromUseAsClause(node, prefix, ctx, out);
      return;
    }
    case 'use_wildcard': {
      emitFromUseWildcard(node, prefix, ctx, out);
      return;
    }
    case 'scoped_use_list': {
      emitFromScopedUseList(node, prefix, ctx, out);
      return;
    }
    case 'use_list': {
      emitFromUseList(node, prefix, ctx, out);
      return;
    }
    /* v8 ignore start */
    default: {
      emitFromUnknownUseShape(node, prefix, ctx, out);
      return;
    }
    /* v8 ignore stop */
  }
}

function emitFromPathLeaf(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  const segments = decodePathSegments(node);
  pushDepSite([...prefix, ...segments], node, ctx, out);
}

function emitFromUseAsClause(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  const inner = node.namedChild(0);
  if (inner) {
    emitFromUseSegment(inner, prefix, ctx, out);
  }
}

function emitFromUseWildcard(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  const inner = node.namedChild(0);
  const segments = inner ? decodePathSegments(inner) : [];
  pushDepSite([...prefix, ...segments, '*'], node, ctx, out);
}

// @graph-ignore-next-line graph:cycle -- intentional recursion over nested `use` scoped-list AST nodes
function emitFromScopedUseList(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  const split = splitScopedUseListChildren(node);
  if (split.list === null) return;
  const newPrefix = [...prefix, ...split.pathSegs];
  emitUseListItems(split.list, newPrefix, ctx, out);
}

function splitScopedUseListChildren(node: Node): {
  readonly pathSegs: readonly string[];
  readonly list: Node | null;
} {
  let pathSegs: readonly string[] = [];
  let list: Node | null = null;
  for (const c of namedChildrenOf(node)) {
    if (c.type === 'use_list') {
      list = c;
    } else if (list === null) {
      pathSegs = decodePathSegments(c);
    }
  }
  return { pathSegs, list };
}

function emitFromUseList(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  emitUseListItems(node, prefix, ctx, out);
}

function emitUseListItems(
  list: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  for (const item of namedChildrenOf(list)) {
    if (item.type === 'self') {
      pushDepSite([...prefix], item, ctx, out);
      continue;
    }
    emitFromUseSegment(item, prefix, ctx, out);
  }
}

/* v8 ignore start */
function emitFromUnknownUseShape(
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  const text = node.text;
  if (text.length > 0) {
    pushDepSite([...prefix, text], node, ctx, out);
  }
}
/* v8 ignore stop */

function decodePathSegments(node: Node): readonly string[] {
  if (
    node.type === 'identifier' ||
    node.type === 'crate' ||
    node.type === 'super' ||
    node.type === 'self'
  ) {
    return [node.text];
  }
  if (node.type === 'scoped_identifier') {
    const out: string[] = [];
    for (const c of namedChildrenOf(node)) {
      out.push(...decodePathSegments(c));
    }
    return out;
  }
  /* v8 ignore next */
  return [];
}

function pushDepSite(
  segments: readonly string[],
  node: Node,
  ctx: UseSiteContext,
  out: DependencySiteRecord[],
): void {
  if (segments.length === 0) {
    /* v8 ignore next */
    return;
  }
  out.push({
    nodeRef: node,
    sourceFileRef: ctx.file,
    ownerHash: ctx.ownerHash,
    specifier: segments.join('::'),
    line: ctx.line,
    column: ctx.column,
  });
}

function collectFromExternCrate(
  decl: Node,
  file: RustParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  for (const c of namedChildrenOf(decl)) {
    if (c.type === 'identifier') {
      out.push({
        nodeRef: decl,
        sourceFileRef: file,
        ownerHash,
        specifier: c.text,
        line: decl.startPosition.row + 1,
        column: decl.startPosition.column,
      });
      return;
    }
  }
}
