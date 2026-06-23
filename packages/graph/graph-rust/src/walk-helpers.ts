/**
 * Shared occurrence-building helpers for the Rust AST walker.
 */

import { childrenOf, nameOf, namedChildrenOf } from '@opensip-cli/graph-adapter-common';

import { digestRustBody } from './body-digest.js';

import type { RustParsedFile } from './parse.js';
import type { CallSiteRecord, FunctionOccurrence } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

export interface Frame {
  readonly ownerHash: string;
  readonly enclosingImpl: string | null;
}

export interface WalkCtx {
  readonly file: RustParsedFile;
  readonly filePathProjectRel: string;
  readonly fileInTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly out: Record<string, FunctionOccurrence[]>;
  readonly callSites: CallSiteRecord[];
}

export function implTargetName(node: Node): string {
  const ty = node.childForFieldName('type');
  if (ty) return ty.text;
  /* v8 ignore start */
  for (const c of namedChildrenOf(node)) {
    if (c.type === 'type_identifier' || c.type === 'generic_type') return c.text;
  }
  return '<anon-impl>';
  /* v8 ignore stop */
}

function classifyVisibility(node: Node): FunctionOccurrence['visibility'] {
  for (const c of childrenOf(node)) {
    if (c.type === 'visibility_modifier') return 'exported';
  }
  return 'module-local';
}

function extractParams(node: Node): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  return collectParamEntries(params);
}

const extractClosureParams = extractParams;

function collectParamEntries(
  params: Node,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of namedChildrenOf(params)) {
    const param = decodeParam(child);
    if (param) out.push(param);
  }
  return out;
}

function decodeParam(child: Node): { name: string; optional: boolean; rest: boolean } | null {
  switch (child.type) {
    case 'self_parameter': {
      return { name: 'self', optional: false, rest: false };
    }
    case 'parameter': {
      const pat = child.childForFieldName('pattern') ?? child.namedChild(0);
      if (!pat) return null;
      return { name: pat.text, optional: false, rest: false };
    }
    /* v8 ignore start */
    case 'identifier': {
      return { name: child.text, optional: false, rest: false };
    }
    default: {
      return null;
    }
    /* v8 ignore stop */
  }
}

function extractAttributes(node: Node): readonly string[] {
  const out: string[] = [];
  for (const c of childrenOf(node)) {
    if (c.type === 'attribute_item' || c.type === 'inner_attribute_item') {
      out.push(c.text.trim());
    }
  }
  const parent = node.parent;
  if (parent) {
    for (const sib of parent.children) {
      if (sib === null || sib.startIndex >= node.startIndex) break;
      if (sib.type === 'attribute_item' || sib.type === 'inner_attribute_item') {
        out.push(sib.text.trim());
      }
    }
  }
  return [...new Set(out)];
}

function hasTestAttribute(node: Node): boolean {
  const attrs = extractAttributes(node);
  for (const a of attrs) {
    if (a.includes('#[test]')) return true;
    /* v8 ignore next */
    if (a.includes('cfg(test)')) return true;
  }
  return false;
}

function classifyRustFunctionKind(
  name: string,
  enclosingImpl: string | null,
): FunctionOccurrence['kind'] {
  if (enclosingImpl === null) return 'function-declaration';
  if (name === 'new') return 'constructor';
  return 'method';
}

export function buildFunctionOccurrence(
  node: Node,
  frame: Frame,
  ctx: WalkCtx,
): FunctionOccurrence | null {
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestRustBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const isTest = ctx.fileInTestFile || hasTestAttribute(node);
  const kind = classifyRustFunctionKind(name, frame.enclosingImpl);
  const qualifiedBase = ctx.filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  const qualifiedName =
    frame.enclosingImpl === null
      ? `${qualifiedBase}::${name}`
      : `${qualifiedBase}::${frame.enclosingImpl}::${name}`;
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName: name,
    qualifiedName,
    filePath: ctx.filePathProjectRel,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    kind,
    params: extractParams(node),
    returnType: null,
    enclosingClass: frame.enclosingImpl,
    decorators: extractAttributes(node),
    visibility: classifyVisibility(node),
    inTestFile: isTest,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
}

export function buildClosureOccurrence(node: Node, ctx: WalkCtx): FunctionOccurrence | null {
  const digest = digestRustBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const simpleName = `<arrow:${ctx.filePathProjectRel}:${String(startLine)}:${String(startCol)}>`;
  const qualifiedBase = ctx.filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName,
    qualifiedName: `${qualifiedBase}::<closure:${String(startLine)}:${String(startCol)}>`,
    filePath: ctx.filePathProjectRel,
    line: startLine,
    column: startCol,
    endLine: node.endPosition.row + 1,
    kind: 'arrow',
    params: extractClosureParams(node),
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'private',
    inTestFile: ctx.fileInTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
}