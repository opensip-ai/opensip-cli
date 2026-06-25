/**
 * Python walkProject — emit FunctionOccurrences + CallSiteRecords.
 *
 * One descent per file, mirroring lang-typescript/walk.ts. Identifies
 * five callable shapes:
 *
 *   - `function_definition` outside a class body  → 'function-declaration'
 *   - `function_definition` inside a class body   → 'method'
 *   - `function_definition` named `__init__`      → 'constructor'
 *   - `lambda`                                    → 'arrow'
 *   - one synthetic `<module-init>` per file
 *
 * Body hashing: sha256 of normalized body text. "Normalized" means:
 *   1. Strip Python comments (`#` to end-of-line).
 *   2. Strip module-level / function-level docstrings — recognized as
 *      a leading `expression_statement` whose only child is a `string`.
 *      This is the textually-conservative choice; pretty-formatter
 *      normalization (e.g. ruff/black-style reflow) is out of scope.
 *   3. Collapse all whitespace runs to a single space, trim.
 *
 * Only string literals **at the top of a function body** are stripped
 * as docstrings. String literals embedded in expressions are preserved.
 *
 * Call-site records:
 *   - `call` node — every Python call expression (`foo()`, `obj.method(...)`,
 *     `f.g.h()`).
 *   - 'creation' edges — for each `lambda` expression nested inside a
 *     parent function/method/module-init, emit a creation edge so
 *     reachability flows through closures even when the lambda's
 *     dispatch is unresolvable. Mirror of lang-typescript's
 *     `isInlineCallable` rule applied to lambdas.
 *
 * Test detection happens here too (mirrors lang-typescript): we don't
 * emit special records, but we tag each occurrence's `inTestFile` flag
 * via the path predicate.
 */

import { relative, sep } from 'node:path';

import {
  childrenOf,
  makeFileClassifier,
  namedChildrenOf,
  nameOf,
  record,
  runWalk,
  synthesizeModuleInit as buildModuleInit,
  type WalkSinks,
} from '@opensip-cli/graph-adapter-common';

import { digestPythonBody, digestSyntheticBody } from './body-digest.js';
import { collectDependencySites } from './walk-dependencies.js';

import type { PythonParsedFile, PythonParsedProject } from './parse.js';
import type { CallSiteRecord, FunctionOccurrence, WalkInput, WalkOutput } from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

const TEST_PATH_RE = /(?:^|\/)tests?\//;
const TEST_FILE_NAME_RE = /(?:^|\/)test_[^/]+\.py$|_test\.py$/;
const GENERATED_PATH_RE = /\bdist\/|\bbuild\/|\.generated\./;

const { isTestFile, isGeneratedFile } = makeFileClassifier({
  testRe: TEST_FILE_NAME_RE,
  generatedRe: GENERATED_PATH_RE,
  testPathRe: TEST_PATH_RE,
});

export { isTestFile };

export function walkProject(input: WalkInput<PythonParsedProject>): WalkOutput {
  return runWalk({ input, walkFile });
}

// @graph-ignore-next-line graph:near-duplicate-function-body -- Python and Rust file walkers intentionally mirror the adapter contract while traversing different grammars.
function walkFile(
  absPath: string,
  file: PythonParsedFile,
  projectDirAbs: string,
  sinks: WalkSinks,
): void {
  const { occurrences: out, callSites, dependencySites } = sinks;
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);

  const qualifiedBase = filePathProjectRel.replace(/\.py$/, '').split('/').join('.');
  const moduleInit = buildModuleInit({
    file,
    filePathProjectRel,
    inTestFile,
    definedInGenerated,
    digestSyntheticBody,
    qualifiedName: `${qualifiedBase}.<module-init>`,
  });
  record(out, moduleInit);

  // Phase 4 (DEC-498): walk top-level imports as dependency sites. Owner
  // is the file's synthesized module-init occurrence.
  collectDependencySites(file, moduleInit.bodyHash, dependencySites);

  const initialFrame: Frame = {
    ownerHash: moduleInit.bodyHash,
    enclosingClass: null,
  };

  const ctx: WalkCtx = {
    file,
    filePathProjectRel,
    inTestFile,
    definedInGenerated,
    out,
    callSites,
  };

  for (const child of childrenOf(file.tree.rootNode)) visit(child, initialFrame, ctx);
}

interface Frame {
  readonly ownerHash: string;
  readonly enclosingClass: string | null;
}

interface WalkCtx {
  readonly file: PythonParsedFile;
  readonly filePathProjectRel: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly out: Record<string, FunctionOccurrence[]>;
  readonly callSites: CallSiteRecord[];
}

// @graph-ignore-next-line graph:cycle -- intentional recursive-descent AST visitor; the cycle is the traversal (visit re-enters via the class/function helpers)
function visit(node: Node, frame: Frame, ctx: WalkCtx): void {
  if (node.type === 'class_definition') {
    visitClass(node, frame, ctx);
    return;
  }
  if (node.type === 'function_definition') {
    visitFunction(node, frame, ctx);
    return;
  }
  if (node.type === 'lambda' && visitLambdaNode(node, frame, ctx)) {
    return;
  }
  if (node.type === 'call') {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'call',
    });
  }
  for (const child of childrenOf(node)) visit(child, frame, ctx);
}

function visitClass(node: Node, frame: Frame, ctx: WalkCtx): void {
  const className = nameOf(node) ?? '<anon-class>';
  // Don't emit a function for the class itself — Python classes are
  // declarations whose top-level statements run at module load. Keep
  // the module-init as the owner; descend with class context for
  // nested function_definitions to be tagged as methods.
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingClass: className };
  for (const child of childrenOf(node)) visit(child, childFrame, ctx);
}

// @graph-ignore-next-line graph:near-duplicate-function-body -- function visitors stay parser-local even when traversal bookkeeping is parallel across adapters.
function visitFunction(node: Node, frame: Frame, ctx: WalkCtx): void {
  const occ = visitFunctionDefinition(node, frame.enclosingClass, ctx);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash, enclosingClass: null };
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of childrenOf(body)) visit(child, childFrame, ctx);
  }
}

function visitLambdaNode(node: Node, frame: Frame, ctx: WalkCtx): boolean {
  const occ = visitLambda(node, ctx);
  if (!occ) return false;
  record(ctx.out, occ);
  if (frame.ownerHash !== occ.bodyHash) {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'creation',
      childHash: occ.bodyHash,
    });
  }
  const body = node.childForFieldName('body');
  if (body) {
    visit(body, { ownerHash: occ.bodyHash, enclosingClass: null }, ctx);
  }
  return true;
}

function visitFunctionDefinition(
  node: Node,
  enclosingClass: string | null,
  ctx: WalkCtx,
): FunctionOccurrence | null {
  const { file, filePathProjectRel, inTestFile, definedInGenerated } = ctx;
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestPythonBody(file.source.slice(node.startIndex, node.endIndex));
  const kind = classifyFunctionKind(name, enclosingClass);
  const qualifiedBase = filePathProjectRel.replace(/\.py$/, '').split('/').join('.');
  const qualifiedName =
    enclosingClass === null
      ? `${qualifiedBase}.${name}`
      : `${qualifiedBase}.${enclosingClass}.${name}`;
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    bodySignature: digest.signature,
    simpleName: name,
    qualifiedName,
    filePath: filePathProjectRel,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    kind,
    params: extractParams(node),
    returnType: null,
    enclosingClass,
    decorators: extractDecorators(node),
    visibility: name.startsWith('_') ? 'module-local' : 'exported',
    inTestFile,
    definedInGenerated,
    calls: [],
  };
}

function classifyFunctionKind(
  name: string,
  enclosingClass: string | null,
): FunctionOccurrence['kind'] {
  if (enclosingClass === null) return 'function-declaration';
  if (name === '__init__') return 'constructor';
  return 'method';
}

function visitLambda(node: Node, ctx: WalkCtx): FunctionOccurrence | null {
  const { file, filePathProjectRel, inTestFile, definedInGenerated } = ctx;
  const digest = digestPythonBody(file.source.slice(node.startIndex, node.endIndex));
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const simpleName = `<arrow:${filePathProjectRel}:${String(startLine)}:${String(startCol)}>`;
  const qualifiedBase = filePathProjectRel.replace(/\.py$/, '').split('/').join('.');
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    bodySignature: digest.signature,
    simpleName,
    qualifiedName: `${qualifiedBase}.<lambda:${String(startLine)}:${String(startCol)}>`,
    filePath: filePathProjectRel,
    line: startLine,
    column: startCol,
    endLine: node.endPosition.row + 1,
    kind: 'arrow',
    params: extractParamsFromField(node, 'parameters'),
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'private',
    inTestFile,
    definedInGenerated,
    calls: [],
  };
}

// ── helpers ───────────────────────────────────────────────────────

function extractParams(node: Node): readonly { name: string; optional: boolean; rest: boolean }[] {
  return extractParamsFromField(node, 'parameters');
}

function extractParamsFromField(
  node: Node,
  fieldName: string,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName(fieldName);
  if (!params) return [];
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of namedChildrenOf(params)) {
    const param = extractParam(child);
    if (param) out.push(param);
  }
  return out;
}

function extractParam(child: Node): { name: string; optional: boolean; rest: boolean } | null {
  switch (child.type) {
    case 'identifier': {
      return { name: child.text, optional: false, rest: false };
    }
    case 'typed_parameter':
    case 'default_parameter':
    case 'typed_default_parameter': {
      const name = child.childForFieldName('name') ?? child.namedChild(0);
      if (!name) return null;
      return {
        name: name.text,
        optional: child.type === 'default_parameter' || child.type === 'typed_default_parameter',
        rest: false,
      };
    }
    /* v8 ignore start */
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern': {
      const name = child.namedChild(0);
      if (!name) return null;
      return { name: name.text, optional: false, rest: true };
    }
    default: {
      return null;
    }
    /* v8 ignore stop */
  }
}

function extractDecorators(node: Node): readonly string[] {
  // tree-sitter-python wraps a function_definition in a `decorated_definition`
  // node when decorators are present. The decorators are siblings of the
  // function_definition inside that wrapper.
  if (node.parent?.type !== 'decorated_definition') return [];
  /* v8 ignore start */
  const out: string[] = [];
  for (const child of namedChildrenOf(node.parent)) {
    if (child.type === 'decorator') {
      // Decorator text is `@expr`; trim the leading `@`.
      const text = child.text.trim();
      out.push(text.startsWith('@') ? text.slice(1) : text);
    }
  }
  return out;
  /* v8 ignore stop */
}
