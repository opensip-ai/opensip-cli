/**
 * Shared occurrence-building helpers for the Rust AST walker.
 */

import {
  childrenOf,
  nameOf,
  namedChildrenOf,
  type WalkTraversalGuard,
} from '@opensip-cli/graph-adapter-common';

import { digestRustBody } from './body-digest.js';

import type { RustParsedFile } from './parse.js';
import type { CallSiteRecord, FunctionOccurrence } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

export interface Frame {
  readonly ownerHash: string;
  readonly enclosingImpl: string | null;
  readonly enclosingTrait: { readonly name: string; readonly exported: boolean } | null;
}

export interface WalkCtx {
  readonly file: RustParsedFile;
  readonly filePathProjectRel: string;
  readonly fileInTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly out: Record<string, FunctionOccurrence[]>;
  readonly callSites: CallSiteRecord[];
  readonly traversal: WalkTraversalGuard;
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

export function hasExportedVisibility(node: Node): boolean {
  for (const c of childrenOf(node)) {
    if (c.type === 'visibility_modifier') return c.text.trim() === 'pub';
  }
  return false;
}

function classifyVisibility(node: Node, frame: Frame): FunctionOccurrence['visibility'] {
  if (hasExportedVisibility(node) || frame.enclosingTrait?.exported === true) return 'exported';
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

/**
 * The attributes that decorate `node`: its own child attribute_items plus the
 * contiguous run of attribute_items immediately preceding it among its siblings.
 * Only the contiguous run counts — the previous logic pushed EVERY earlier
 * `attribute_item` in the block, so a function inherited attributes from
 * unrelated earlier items (e.g. a `#[derive(Debug)] struct Cfg;` before it),
 * corrupting `decorators` and `inTestFile`, which gate `orphan-subtree`,
 * `large-function`, and the other production rules.
 */
function precedingAttributeRun(node: Node): string[] {
  const parent = node.parent;
  if (!parent) return [];
  // A preceding non-attribute item resets the run; comments between an attribute
  // and its item do not break it.
  const run: string[] = [];
  for (const sib of parent.children) {
    if (sib === null) continue;
    if (sib.startIndex >= node.startIndex) break;
    if (sib.type === 'attribute_item' || sib.type === 'inner_attribute_item') {
      run.push(sib.text.trim());
    } else if (!sib.type.includes('comment')) {
      run.length = 0;
    }
  }
  return run;
}

function extractAttributes(node: Node): readonly string[] {
  const out: string[] = [];
  for (const c of childrenOf(node)) {
    if (c.type === 'attribute_item' || c.type === 'inner_attribute_item') {
      out.push(c.text.trim());
    }
  }
  out.push(...precedingAttributeRun(node));
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
  enclosingTrait: Frame['enclosingTrait'],
): FunctionOccurrence['kind'] {
  if (enclosingImpl !== null && name === 'new') return 'constructor';
  if (enclosingImpl === null && enclosingTrait === null) return 'function-declaration';
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
  const kind = classifyRustFunctionKind(name, frame.enclosingImpl, frame.enclosingTrait);
  const enclosingClass = frame.enclosingImpl ?? frame.enclosingTrait?.name ?? null;
  const qualifiedBase = ctx.filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  const qualifiedName =
    enclosingClass === null
      ? `${qualifiedBase}::${name}`
      : `${qualifiedBase}::${enclosingClass}::${name}`;
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    bodySignature: digest.signature,
    simpleName: name,
    qualifiedName,
    filePath: ctx.filePathProjectRel,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    kind,
    params: extractParams(node),
    returnType: null,
    enclosingClass,
    decorators: extractAttributes(node),
    visibility: classifyVisibility(node, frame),
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
    bodySignature: digest.signature,
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
