// @fitness-ignore-file context-mutation -- `ctx: WalkCtx` here is a function-scoped traversal accumulator (callSites array, occurrence sink, parser refs) threaded through the AST walk, NOT a shared request/execution context. `ctx.callSites.push(...)` is the intended local-accumulator append. The shared check-side `LOCAL_DECLARATION_PATTERNS` heuristic doesn't see it because `ctx` arrives as a typed parameter, not via `const ctx = …`.
/**
 * Go walkProject — emit FunctionOccurrences + CallSiteRecords.
 *
 * Identifies the callable shapes:
 *
 *   - `function_declaration`                      → 'function-declaration'
 *   - `method_declaration` (has receiver)         → 'method'
 *     - `enclosingClass` = receiver type name (e.g. `Foo` in
 *       `func (f *Foo) bar() {}`). Pointer `*Foo` and value `Foo`
 *       receivers both yield `Foo` — the dereference is stripped.
 *   - `func_literal`                              → 'arrow'
 *   - one synthetic `<module-init>` per file owning top-level non-fn
 *     items (`package`, `import`, `var`, `const`, `type`).
 *
 * Body hashing: sha256 of normalized body text. Normalization:
 *   1. Strip line comments (`// …` to end-of-line).
 *   2. Strip block comments (`/* … *\/`). Go does NOT support nested
 *      block comments, unlike Rust.
 *   3. Preserve string literals: both interpreted (`"…"`) and raw
 *      (backtick `…`) forms. Their content is part of behavior.
 *   4. Preserve rune literals (`'x'`, `'\n'`).
 *   5. Collapse whitespace.
 *
 * Call-site records:
 *   - `call_expression` — every Go function/method/built-in call.
 *     The resolver decodes:
 *       - `foo(args)`              — identifier target
 *       - `obj.Method(args)`       — selector_expression's `field`
 *       - `pkg.Func(args)`         — same selector_expression shape
 *       - `Type{}.method(args)`    — selector_expression on composite_literal
 *   - 'creation' edges — for each `func_literal` nested inside a parent
 *     function/method/module-init, emit a creation edge so reachability
 *     flows through closures even when dispatch is unresolvable.
 *     Mirror of lang-typescript's `isInlineCallable`.
 *
 * Test detection:
 *   - File-level: filename ends with `_test.go`. Go's toolchain enforces
 *     this convention, so the predicate is exact.
 *   - No function-level detection — `func TestXxx(t *testing.T)` only
 *     compiles into a test when its file is `_test.go`.
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
} from '@opensip-tools/graph-adapter-common';

import { digestGoBody, digestSyntheticBody } from './body-digest.js';
import {
  classifyVisibility,
  extractClosureParams,
  extractPackageName,
  extractParams,
  extractReceiverType,
} from './walk-metadata.js';

import type { GoParsedFile, GoParsedProject } from './parse.js';
import type {
  CallSiteRecord,
  DependencySiteRecord,
  FunctionOccurrence,
  WalkInput,
  WalkOutput,
} from '@opensip-tools/graph';
import type { Node } from '@opensip-tools/tree-sitter';

const TEST_FILE_NAME_RE = /(?:^|\/)[^/]+_test\.go$/;
const GENERATED_PATH_RE = /\bvendor\/|\.pb\.go$|_generated\.go$|\.gen\.go$|zz_generated_/;

// Go's `_test.go` name convention is exact — no path-based matcher needed.
const { isTestFile, isGeneratedFile } = makeFileClassifier({
  testRe: TEST_FILE_NAME_RE,
  generatedRe: GENERATED_PATH_RE,
});

export { isTestFile };

export function walkProject(input: WalkInput<GoParsedProject>): WalkOutput {
  return runWalk({ input, walkFile });
}

function walkFile(
  absPath: string,
  file: GoParsedFile,
  projectDirAbs: string,
  sinks: WalkSinks,
): void {
  const { occurrences: out, callSites, dependencySites } = sinks;
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);
  const packageName = extractPackageName(file);

  const qualifiedBase = `${packageName}/${filePathProjectRel}`.replace(/\.go$/, '');
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

  const ctx: WalkCtx = {
    file,
    filePathProjectRel,
    packageName,
    fileInTestFile: inTestFile,
    definedInGenerated,
    out,
    callSites,
  };
  const initialFrame: Frame = { ownerHash: moduleInit.bodyHash };

  for (const child of childrenOf(file.tree.rootNode)) visit(child, initialFrame, ctx);
}

/**
 * Walk a Go file's top-level `import_declaration` nodes; emit one
 * `DependencySiteRecord` per `import_spec`, regardless of whether the
 * declaration is single (`import "fmt"`) or grouped (`import ( … )`).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498). The emitted
 * `specifier` is the raw import path WITHOUT the surrounding quotes
 * (e.g. `'fmt'`, `'github.com/user/repo/pkg/sub'`).
 *
 * Aliased imports (`alias "path"`), blank imports (`_ "path"`), and dot
 * imports (`. "path"`) all emit one dep site keyed by the import path;
 * the alias / blank / dot prefix doesn't change the dependency target.
 *
 * Out of scope at v1:
 *   - Conditional / nested imports inside function bodies (Go doesn't
 *     permit these — imports are always file-top-level).
 *   - `go.work`-mediated multi-module workspaces (a follow-up).
 */
function collectDependencySites(
  file: GoParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of namedChildrenOf(file.tree.rootNode)) {
    if (stmt.type !== 'import_declaration') continue;
    collectFromImportDeclaration(stmt, file, moduleInitHash, out);
  }
}

function collectFromImportDeclaration(
  decl: Node,
  file: GoParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const child of namedChildrenOf(decl)) {
    if (child.type === 'import_spec') {
      pushImportSpec(child, file, moduleInitHash, out);
    } else if (child.type === 'import_spec_list') {
      for (const spec of namedChildrenOf(child)) {
        if (spec.type === 'import_spec') {
          pushImportSpec(spec, file, moduleInitHash, out);
        }
      }
    }
  }
}

function pushImportSpec(
  spec: Node,
  file: GoParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  // The `path` field is an interpreted_string_literal. Its `text` is the
  // quoted form (`"fmt"`); strip outer quotes to get the raw specifier.
  const pathNode = spec.childForFieldName('path') ?? findInterpretedString(spec);
  if (!pathNode) return;
  const specifier = unquoteGoStringLiteral(pathNode.text);
  if (specifier === null) return;
  out.push({
    nodeRef: spec,
    sourceFileRef: file,
    ownerHash,
    specifier,
    line: spec.startPosition.row + 1,
    column: spec.startPosition.column,
  });
}

function findInterpretedString(node: Node): Node | null {
  /* v8 ignore start */
  for (const child of namedChildrenOf(node)) {
    if (child.type === 'interpreted_string_literal') return child;
  }
  return null;
  /* v8 ignore stop */
}

function unquoteGoStringLiteral(text: string): string | null {
  // Go import paths are always interpreted strings — wrapped in `"…"`
  // with no escape sequences relevant to module paths. (Raw `\`…\``
  // strings are NOT valid in import declarations per the Go spec.)
  if (text.length < 2) return null;
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  /* v8 ignore next */
  return null;
}

interface Frame {
  readonly ownerHash: string;
}

interface WalkCtx {
  readonly file: GoParsedFile;
  readonly filePathProjectRel: string;
  readonly packageName: string;
  readonly fileInTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly out: Record<string, FunctionOccurrence[]>;
  readonly callSites: CallSiteRecord[];
}

// @graph-ignore-next-line graph:cycle -- intentional recursive-descent AST visitor; the cycle is the traversal (visit re-enters via visitFunction/visitClosure)
function visit(node: Node, frame: Frame, ctx: WalkCtx): void {
  if (node.type === 'function_declaration') {
    visitFunction(node, frame, ctx, null);
    return;
  }
  if (node.type === 'method_declaration') {
    const receiverType = extractReceiverType(node);
    visitFunction(node, frame, ctx, receiverType);
    return;
  }
  if (node.type === 'func_literal' && visitClosure(node, frame, ctx)) {
    return;
  }
  if (node.type === 'call_expression') {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'call',
    });
  }
  for (const child of childrenOf(node)) visit(child, frame, ctx);
}

function visitFunction(node: Node, frame: Frame, ctx: WalkCtx, receiverType: string | null): void {
  const occ = buildFunctionOccurrence(node, ctx, receiverType);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash };
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of childrenOf(body)) visit(child, childFrame, ctx);
  }
}

function visitClosure(node: Node, frame: Frame, ctx: WalkCtx): boolean {
  const occ = buildClosureOccurrence(node, ctx);
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
    visit(body, { ownerHash: occ.bodyHash }, ctx);
  }
  return true;
}

function buildFunctionOccurrence(
  node: Node,
  ctx: WalkCtx,
  receiverType: string | null,
): FunctionOccurrence | null {
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestGoBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const kind: FunctionOccurrence['kind'] =
    receiverType === null ? 'function-declaration' : 'method';
  const qualifiedBase = `${ctx.packageName}/${ctx.filePathProjectRel}`.replace(/\.go$/, '');
  const qualifiedName =
    receiverType === null
      ? `${qualifiedBase}.${name}`
      : `${qualifiedBase}.(${receiverType}).${name}`;
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
    enclosingClass: receiverType,
    decorators: [],
    visibility: classifyVisibility(name),
    inTestFile: ctx.fileInTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
}

function buildClosureOccurrence(node: Node, ctx: WalkCtx): FunctionOccurrence | null {
  const digest = digestGoBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const simpleName = `<arrow:${ctx.filePathProjectRel}:${String(startLine)}:${String(startCol)}>`;
  const qualifiedBase = `${ctx.packageName}/${ctx.filePathProjectRel}`.replace(/\.go$/, '');
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName,
    qualifiedName: `${qualifiedBase}.<closure:${String(startLine)}:${String(startCol)}>`,
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
