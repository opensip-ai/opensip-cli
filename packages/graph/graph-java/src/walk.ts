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

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';

import type { JavaParsedFile, JavaParsedProject } from './parse.js';
import type {
  CallSiteRecord,
  FunctionOccurrence,
  ParseError,
  WalkInput,
  WalkOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

const TEST_PATH_RE = /(?:^|\/)test\//;
const TEST_FILE_NAME_RE = /(?:^|\/)[^/]*(?:Test|Tests|IT)\.java$/;
const GENERATED_PATH_RE = /(?:\b(?:target|build|out|generated|generated-sources)\/)|(?:\$Pb\.java$)/;

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
  const occurrences: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const callSites: CallSiteRecord[] = [];
  const parseErrors: ParseError[] = [];

  const sortedPaths = [...input.files].filter((p) => input.project.files.has(p)).sort();

  for (const path of sortedPaths) {
    const file = input.project.files.get(path);
    if (!file) continue;
    try {
      walkFile(path, file, input.projectDirAbs, occurrences, callSites);
    } catch (error) {
      parseErrors.push({
        filePath: relative(input.projectDirAbs, path),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { occurrences, callSites, parseErrors };
}

function walkFile(
  absPath: string,
  file: JavaParsedFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
  callSites: CallSiteRecord[],
): void {
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);
  const packageName = extractPackageName(file);

  const moduleInit = synthesizeModuleInit(
    file,
    filePathProjectRel,
    packageName,
    inTestFile,
    definedInGenerated,
  );
  record(out, moduleInit);

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

  for (const child of file.tree.rootNode.children) visit(child, initialFrame, ctx);
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

function visit(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
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
  for (const child of node.children) visit(child, frame, ctx);
}

function visitTypeDeclaration(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
  const typeName = nameOf(node) ?? '<anon-type>';
  // Type declarations don't emit a function — their bodies' methods do.
  // Keep the same owner hash but update enclosingClass for children.
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingClass: typeName };
  for (const child of node.children) visit(child, childFrame, ctx);
}

function visitMethodOrConstructor(
  node: Parser.SyntaxNode,
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
    for (const child of body.children) visit(child, childFrame, ctx);
  }
}

function visitLambda(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): boolean {
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
  node: Parser.SyntaxNode,
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
  const qualifiedName = frame.enclosingClass === null
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

function buildLambdaOccurrence(
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
): FunctionOccurrence | null {
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

function synthesizeModuleInit(
  file: JavaParsedFile,
  filePathProjectRel: string,
  packageName: string,
  inTestFile: boolean,
  definedInGenerated: boolean,
): FunctionOccurrence {
  const root = file.tree.rootNode;
  const topLevelText = root.children
    .map((c) => file.source.slice(c.startIndex, c.endIndex))
    .join('\n');
  const digest = digestSyntheticBody(`${filePathProjectRel}\n${topLevelText}`);
  const simpleName = `<module-init:${filePathProjectRel}>`;
  const qualifiedBase = packageQualifier(packageName, filePathProjectRel);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName,
    qualifiedName: `${qualifiedBase}.<module-init>`,
    filePath: filePathProjectRel,
    line: 1,
    column: 0,
    endLine: root.endPosition.row + 1,
    kind: 'module-init',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile,
    definedInGenerated,
    calls: [],
  };
}

// ── helpers ───────────────────────────────────────────────────────

function nameOf(node: Parser.SyntaxNode): string | null {
  const name = node.childForFieldName('name');
  return name ? name.text : null;
}

function packageQualifier(packageName: string, filePathProjectRel: string): string {
  if (packageName.length > 0) return packageName;
  // Fallback: derive a path-based qualifier (e.g. `src/main/java/Foo.java` →
  // `src.main.java.Foo`). Real Java files almost always have a `package`
  // declaration, so this is only hit for hand-written one-off files.
  return filePathProjectRel.replace(/\.java$/, '').replaceAll('/', '.');
}

function extractPackageName(file: JavaParsedFile): string {
  for (const child of file.tree.rootNode.children) {
    if (child.type === 'package_declaration') {
      // package_declaration: `package` keyword + scoped/qualified identifier + `;`
      for (const c of child.namedChildren) {
        if (c.type === 'scoped_identifier' || c.type === 'identifier') return c.text;
      }
    }
  }
  return '';
}

/**
 * Find the `modifiers` named child of a method/constructor declaration.
 *
 * Note: tree-sitter-java exposes the modifier list as a named child of
 * type `modifiers`, NOT as a named field. `childForFieldName('modifiers')`
 * returns null — only iteration works.
 */
function findModifiersNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const c of node.children) {
    if (c.type === 'modifiers') return c;
  }
  return null;
}

function classifyVisibility(node: Parser.SyntaxNode): FunctionOccurrence['visibility'] {
  // Visibility keywords appear inside the `modifiers` node as anonymous
  // children with type === 'public' / 'protected' / 'private'.
  //   public / protected  → 'exported'
  //   private             → 'module-local' (file-local in Java terms)
  //   none                → 'module-local' (package-private)
  const modifiers = findModifiersNode(node);
  if (modifiers) {
    for (const c of modifiers.children) {
      if (c.type === 'public' || c.type === 'protected') return 'exported';
      if (c.type === 'private') return 'module-local';
    }
  }
  return 'module-local';
}

function extractAnnotations(node: Parser.SyntaxNode): readonly string[] {
  const out: string[] = [];
  const modifiers = findModifiersNode(node);
  if (!modifiers) return out;
  for (const c of modifiers.children) {
    if (c.type === 'annotation' || c.type === 'marker_annotation') {
      out.push(c.text.trim());
    }
  }
  return out;
}

function hasTestAnnotation(decorators: readonly string[]): boolean {
  for (const d of decorators) {
    // Matches `@Test`, `@org.junit.Test`, `@ParameterizedTest`, etc.
    if (/@(?:[\w.]*\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/.test(d)) {
      return true;
    }
  }
  return false;
}

function extractParams(
  node: Parser.SyntaxNode,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of params.namedChildren) {
    if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
      const nameNode = child.childForFieldName('name') ?? findIdentifierChild(child);
      if (!nameNode) continue;
      out.push({
        name: nameNode.text,
        optional: false,
        rest: child.type === 'spread_parameter',
      });
    }
  }
  return out;
}

function extractLambdaParams(
  node: Parser.SyntaxNode,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  // tree-sitter-java's lambda_expression `parameters` can be:
  //   - identifier               — `x -> x + 1`
  //   - formal_parameters        — `(int x) -> x + 1`
  //   - inferred_parameters      — `(x, y) -> x + y`
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  if (params.type === 'identifier') {
    return [{ name: params.text, optional: false, rest: false }];
  }
  if (params.type === 'inferred_parameters') {
    const out: { name: string; optional: boolean; rest: boolean }[] = [];
    for (const c of params.namedChildren) {
      if (c.type === 'identifier') out.push({ name: c.text, optional: false, rest: false });
    }
    return out;
  }
  // formal_parameters falls through to the standard extractor.
  /* v8 ignore start */
  if (params.type === 'formal_parameters') return extractParams(node);
  return [];
  /* v8 ignore stop */
}

function findIdentifierChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const c of node.namedChildren) {
    if (c.type === 'identifier') return c;
  }
  /* v8 ignore next */
  return null;
}

// ── body normalization ────────────────────────────────────────────

interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

function digestJavaBody(text: string): BodyDigest {
  const normalized = normalizeWhitespace(stripJavaComments(text));
  return { hash: sha256(normalized), size: normalized.length };
}

const digestSyntheticBody = digestJavaBody;

/**
 * Strip Java `//` line comments and `/* … *\/` block comments (which
 * include Javadoc `/** … *\/` — same scanner). Java block comments do
 * NOT nest. Preserve string literals (regular `"…"` and text blocks
 * `"""…"""`) and char literals.
 */
function stripJavaComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const next2 = text.slice(i, i + 2);
    if (next2 === '//') {
      i = skipToEndOfLine(text, i);
      continue;
    }
    if (next2 === '/*') {
      i = skipBlockComment(text, i + 2);
      continue;
    }
    // Text block: `"""…"""`. Must check before regular `"` because the
    // opening triple-quote starts with `"`.
    if (text.slice(i, i + 3) === '"""') {
      const block = consumeTextBlock(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    const c = text[i];
    if (c === '"') {
      const block = consumeStringLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === "'") {
      const block = consumeCharLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function skipToEndOfLine(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function skipBlockComment(text: string, start: number): number {
  // Java block comments do NOT nest. Scan to the first `*/`.
  let i = start;
  while (i < text.length) {
    if (text.slice(i, i + 2) === '*/') return i + 2;
    i++;
  }
  /* v8 ignore next */
  return i;
}

function consumeStringLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  let i = start + 1;
  let buf = '"';
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      buf += '"';
      i++;
      break;
    }
    /* v8 ignore next */
    if (text[i] === '\n') break;
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

function consumeTextBlock(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // Text blocks span newlines and end at the next un-escaped `"""`.
  let i = start + 3;
  let buf = '"""';
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text.slice(i, i + 3) === '"""') {
      buf += '"""';
      i += 3;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

function consumeCharLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  let i = start + 1;
  let buf = "'";
  let escape = false;
  while (i < text.length) {
    const c = text[i];
    if (escape) {
      buf += c;
      escape = false;
      i++;
      continue;
    }
    if (c === '\\') {
      buf += c;
      escape = true;
      i++;
      continue;
    }
    if (c === "'") {
      buf += c;
      i++;
      break;
    }
    /* v8 ignore next */
    if (c === '\n') break;
    buf += c;
    i++;
  }
  return { text: buf, index: i };
}

function normalizeWhitespace(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── output helpers ────────────────────────────────────────────────

function record(out: Record<string, FunctionOccurrence[]>, occ: FunctionOccurrence): void {
  const list = out[occ.simpleName];
  if (list) list.push(occ);
  else out[occ.simpleName] = [occ];
}

export function isTestFile(rel: string): boolean {
  return TEST_PATH_RE.test(rel) || TEST_FILE_NAME_RE.test(rel);
}

function isGeneratedFile(rel: string): boolean {
  return GENERATED_PATH_RE.test(rel);
}
