// @fitness-ignore-file context-mutation -- `ctx: WalkCtx` here is a function-scoped traversal accumulator (callSites array, occurrence sink, parser refs) threaded through the AST walk, NOT a shared request/execution context. `ctx.callSites.push(...)` is the intended local-accumulator append. The check's `LOCAL_DECLARATION_PATTERNS` heuristic doesn't see it because `ctx` arrives as a typed parameter, not via `const ctx = …`.
/**
 * Java walkProject — emit FunctionOccurrences + CallSiteRecords.
 *
 * Identifies the callable shapes:
 *
 *   - `method_declaration` inside a type body          → 'method'
 *     - `enclosingClass` = immediate enclosing
 *       class/interface/record/enum/annotation_type name.
 *   - `constructor_declaration`                        → 'constructor'
 *   - `lambda_expression`                              → 'arrow'
 *   - one synthetic `<module-init>` per file owning the file's
 *     top-level structure (package, imports, type declarations).
 *
 * Note: Java doesn't have free-standing top-level functions. All
 * methods live inside a type. The `'function-declaration'` kind is
 * unused for Java; methods at any depth get kind='method' (or
 * 'constructor' for ctor declarations).
 *
 * Body hashing: sha256 of normalized body text. Normalization:
 *   1. Strip line comments (`// …` to end-of-line).
 *   2. Strip block comments (`/* … *\/`). Java block comments do NOT
 *      nest (unlike Rust).
 *   3. Strip Javadoc comments — they're a `/**` subset of block
 *      comments and the same scanner handles them.
 *   4. Preserve string literals: both regular `"…"` and text blocks
 *      `"""…"""` (Java 15+). Their content is part of behavior.
 *   5. Preserve char literals (`'x'`, `'\n'`).
 *   6. Collapse whitespace.
 *
 * Call-site records:
 *   - `method_invocation`            — `foo(...)`, `obj.foo(...)`,
 *                                       `Class.foo(...)`, `this.foo(...)`,
 *                                       `super.foo(...)`.
 *   - `object_creation_expression`   — `new Foo(...)` invokes the
 *                                       constructor; resolver treats
 *                                       the type name as the target.
 *   - `explicit_constructor_invocation` — `super(...)` / `this(...)`
 *                                       inside a constructor body.
 *   - 'creation' edges for `lambda_expression` — reachability flows
 *     through closures even when their dispatch is unresolvable.
 *   - `method_reference` (`Foo::bar`) is NOT recorded — it creates a
 *     callable handle but doesn't invoke. Skipping avoids inflating
 *     the graph with edges that never fire at that source location.
 *
 * Test detection (file-level):
 *   - Path contains `/test/` (catches Maven/Gradle `src/test/java/`).
 *   - Filename ends with `Test.java`, `Tests.java`, or `IT.java`.
 *
 * Test detection (function-level):
 *   - Methods annotated `@Test` (JUnit 4/5) are tagged `inTestFile`
 *     even when the file path doesn't match. Inline test methods
 *     are a common pattern; this honors them.
 */

import { relative, sep } from 'node:path';

import {
  childrenOf,
  makeFileClassifier,
  nameOf,
  record,
  runWalk,
  synthesizeModuleInit as buildModuleInit,
  type WalkSinks,
} from '@opensip-tools/graph-adapter-common';

import { digestJavaBody, digestSyntheticBody } from './body-digest.js';
import { collectDependencySites } from './walk-dependencies.js';
import {
  classifyVisibility,
  extractAnnotations,
  extractLambdaParams,
  extractPackageName,
  extractParams,
  hasTestAnnotation,
  packageQualifier,
} from './walk-metadata.js';

import type { JavaParsedFile, JavaParsedProject } from './parse.js';
import type {
  CallSiteRecord,
  FunctionOccurrence,
  WalkInput,
  WalkOutput,
} from '@opensip-tools/graph';
import type { Node } from '@opensip-tools/tree-sitter';

const TEST_PATH_RE = /(?:^|\/)test\//;
const TEST_FILE_NAME_RE = /(?:^|\/)[^/]*(?:Test|Tests|IT)\.java$/;
const GENERATED_PATH_RE =
  /(?:\b(?:target|build|out|generated|generated-sources)\/)|(?:\$Pb\.java$)/;

const { isTestFile, isGeneratedFile } = makeFileClassifier({
  testRe: TEST_FILE_NAME_RE,
  generatedRe: GENERATED_PATH_RE,
  testPathRe: TEST_PATH_RE,
});

export { isTestFile };

// Type declarations that introduce an enclosing-class context for the
// methods/constructors inside them.
const TYPE_DECL_NODES: ReadonlySet<string> = new Set([
  'class_declaration',
  'interface_declaration',
  'record_declaration',
  'enum_declaration',
  'annotation_type_declaration',
]);

// Call-site node kinds that the walk surfaces as 'call' records.
const CALL_NODES: ReadonlySet<string> = new Set([
  'method_invocation',
  'object_creation_expression',
  'explicit_constructor_invocation',
]);

export function walkProject(input: WalkInput<JavaParsedProject>): WalkOutput {
  return runWalk({ input, walkFile });
}

function walkFile(
  absPath: string,
  file: JavaParsedFile,
  projectDirAbs: string,
  sinks: WalkSinks,
): void {
  const { occurrences: out, callSites, dependencySites } = sinks;
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);
  const packageName = extractPackageName(file);

  const moduleInit = buildModuleInit({
    file,
    filePathProjectRel,
    inTestFile,
    definedInGenerated,
    digestSyntheticBody,
    qualifiedName: `${packageQualifier(packageName, filePathProjectRel)}.<module-init>`,
  });
  record(out, moduleInit);

  // Phase 4 (DEC-498): walk top-level `import` declarations as dependency
  // sites. Owner is the file's synthesized module-init occurrence.
  // Implicit `java.lang.*` and same-package imports are NOT synthesized —
  // only explicit `import_declaration` nodes are emitted.
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
  const initialFrame: Frame = { ownerHash: moduleInit.bodyHash, enclosingClass: null };

  for (const child of childrenOf(file.tree.rootNode)) visit(child, initialFrame, ctx);
}

interface Frame {
  readonly ownerHash: string;
  readonly enclosingClass: string | null;
}

interface WalkCtx {
  readonly file: JavaParsedFile;
  readonly filePathProjectRel: string;
  readonly packageName: string;
  readonly fileInTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly out: Record<string, FunctionOccurrence[]>;
  readonly callSites: CallSiteRecord[];
}

// @graph-ignore-next-line graph:cycle -- intentional recursive-descent AST visitor; the cycle is the traversal (visit re-enters via the type/member helpers)
function visit(node: Node, frame: Frame, ctx: WalkCtx): void {
  if (TYPE_DECL_NODES.has(node.type)) {
    visitTypeDeclaration(node, frame, ctx);
    return;
  }
  if (node.type === 'method_declaration') {
    visitMethodOrConstructor(node, frame, ctx, 'method');
    return;
  }
  if (node.type === 'constructor_declaration') {
    visitMethodOrConstructor(node, frame, ctx, 'constructor');
    return;
  }
  if (node.type === 'lambda_expression' && visitLambda(node, frame, ctx)) {
    return;
  }
  if (CALL_NODES.has(node.type)) {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'call',
    });
  }
  for (const child of childrenOf(node)) visit(child, frame, ctx);
}

function visitTypeDeclaration(node: Node, frame: Frame, ctx: WalkCtx): void {
  const typeName = nameOf(node) ?? '<anon-type>';
  // Type declarations don't emit a function — their bodies' methods do.
  // Keep the same owner hash but update enclosingClass for children.
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingClass: typeName };
  for (const child of childrenOf(node)) visit(child, childFrame, ctx);
}

function visitMethodOrConstructor(
  node: Node,
  frame: Frame,
  ctx: WalkCtx,
  kind: 'method' | 'constructor',
): void {
  const occ = buildMethodOccurrence(node, frame, ctx, kind);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash, enclosingClass: null };
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of childrenOf(body)) visit(child, childFrame, ctx);
  }
}

function visitLambda(node: Node, frame: Frame, ctx: WalkCtx): boolean {
  const occ = buildLambdaOccurrence(node, ctx);
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

function buildMethodOccurrence(
  node: Node,
  frame: Frame,
  ctx: WalkCtx,
  kind: 'method' | 'constructor',
): FunctionOccurrence | null {
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestJavaBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const decorators = extractAnnotations(node);
  const inTest = ctx.fileInTestFile || hasTestAnnotation(decorators);
  const visibility = classifyVisibility(node);
  const qualifiedBase = packageQualifier(ctx.packageName, ctx.filePathProjectRel);
  const qualifiedName =
    frame.enclosingClass === null
      ? `${qualifiedBase}.${name}`
      : `${qualifiedBase}.${frame.enclosingClass}.${name}`;
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
    enclosingClass: frame.enclosingClass,
    decorators,
    visibility,
    inTestFile: inTest,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
}

function buildLambdaOccurrence(node: Node, ctx: WalkCtx): FunctionOccurrence | null {
  const digest = digestJavaBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const simpleName = `<arrow:${ctx.filePathProjectRel}:${String(startLine)}:${String(startCol)}>`;
  const qualifiedBase = packageQualifier(ctx.packageName, ctx.filePathProjectRel);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName,
    qualifiedName: `${qualifiedBase}.<lambda:${String(startLine)}:${String(startCol)}>`,
    filePath: ctx.filePathProjectRel,
    line: startLine,
    column: startCol,
    endLine: node.endPosition.row + 1,
    kind: 'arrow',
    params: extractLambdaParams(node),
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'private',
    inTestFile: ctx.fileInTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
}
