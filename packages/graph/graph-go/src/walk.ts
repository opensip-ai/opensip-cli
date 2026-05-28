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

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';

import type { GoParsedFile, GoParsedProject } from './parse.js';
import type {
  CallSiteRecord,
  DependencySiteRecord,
  FunctionOccurrence,
  ParseError,
  WalkInput,
  WalkOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

const TEST_FILE_NAME_RE = /(?:^|\/)[^/]+_test\.go$/;
const GENERATED_PATH_RE = /\bvendor\/|\.pb\.go$|_generated\.go$|\.gen\.go$|zz_generated_/;

export function walkProject(input: WalkInput<GoParsedProject>): WalkOutput {
  const occurrences: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const callSites: CallSiteRecord[] = [];
  const dependencySites: DependencySiteRecord[] = [];
  const parseErrors: ParseError[] = [];

  const sortedPaths = [...input.files].filter((p) => input.project.files.has(p)).sort();

  for (const path of sortedPaths) {
    const file = input.project.files.get(path);
    if (!file) continue;
    try {
      walkFile(path, file, input.projectDirAbs, occurrences, callSites, dependencySites);
    } catch (error) {
      parseErrors.push({
        filePath: relative(input.projectDirAbs, path),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { occurrences, callSites, dependencySites, parseErrors };
}

function walkFile(
  absPath: string,
  file: GoParsedFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
  callSites: CallSiteRecord[],
  dependencySites: DependencySiteRecord[],
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

  for (const child of file.tree.rootNode.children) visit(child, initialFrame, ctx);
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
  for (const stmt of file.tree.rootNode.namedChildren) {
    if (stmt.type !== 'import_declaration') continue;
    collectFromImportDeclaration(stmt, file, moduleInitHash, out);
  }
}

function collectFromImportDeclaration(
  decl: Parser.SyntaxNode,
  file: GoParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const child of decl.namedChildren) {
    if (child.type === 'import_spec') {
      pushImportSpec(child, file, moduleInitHash, out);
    } else if (child.type === 'import_spec_list') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'import_spec') {
          pushImportSpec(spec, file, moduleInitHash, out);
        }
      }
    }
  }
}

function pushImportSpec(
  spec: Parser.SyntaxNode,
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

function findInterpretedString(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  /* v8 ignore start */
  for (const child of node.namedChildren) {
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

function visit(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
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
  for (const child of node.children) visit(child, frame, ctx);
}

function visitFunction(
  node: Parser.SyntaxNode,
  frame: Frame,
  ctx: WalkCtx,
  receiverType: string | null,
): void {
  const occ = buildFunctionOccurrence(node, ctx, receiverType);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash };
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of body.children) visit(child, childFrame, ctx);
  }
}

function visitClosure(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): boolean {
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
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
  receiverType: string | null,
): FunctionOccurrence | null {
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestGoBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const kind: FunctionOccurrence['kind'] = receiverType === null ? 'function-declaration' : 'method';
  const qualifiedBase = `${ctx.packageName}/${ctx.filePathProjectRel}`.replace(/\.go$/, '');
  const qualifiedName = receiverType === null
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

function buildClosureOccurrence(
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
): FunctionOccurrence | null {
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

function synthesizeModuleInit(
  file: GoParsedFile,
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
  const qualifiedBase = `${packageName}/${filePathProjectRel}`.replace(/\.go$/, '');
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

function extractPackageName(file: GoParsedFile): string {
  for (const child of file.tree.rootNode.children) {
    if (child.type === 'package_clause') {
      // package_clause: `package` keyword followed by identifier
      for (const c of child.children) {
        if (c.type === 'package_identifier' || c.type === 'identifier') return c.text;
      }
    }
  }
  /* v8 ignore next */
  return 'main';
}

function extractReceiverType(node: Parser.SyntaxNode): string | null {
  // method_declaration has a `receiver` field of type parameter_list
  // containing one parameter_declaration. The declaration's `type`
  // is either pointer_type (e.g. `*Foo`) or type_identifier (`Foo`).
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return null;
  for (const param of receiver.namedChildren) {
    if (param.type !== 'parameter_declaration') continue;
    const ty = param.childForFieldName('type') ?? param.namedChild(param.namedChildCount - 1);
    if (!ty) continue;
    return decodeReceiverTypeNode(ty);
  }
  /* v8 ignore next */
  return null;
}

function decodeReceiverTypeNode(node: Parser.SyntaxNode): string | null {
  if (node.type === 'pointer_type') {
    // *Foo or *Foo[T] — descend through the pointer to the named type.
    const inner = node.namedChild(0);
    return inner ? decodeReceiverTypeNode(inner) : null;
  }
  if (node.type === 'type_identifier') return node.text;
  if (node.type === 'generic_type') {
    // Foo[T] — the trailing name is the type. tree-sitter-go usually
    // exposes the base via a named child.
    const inner = node.childForFieldName('type') ?? node.namedChild(0);
    return inner ? decodeReceiverTypeNode(inner) : null;
  }
  /* v8 ignore next */
  return node.text;
}

function classifyVisibility(name: string): FunctionOccurrence['visibility'] {
  // Go visibility is determined by the first character's case. The
  // primary check is "is the first character an uppercase ASCII letter".
  // Unicode-case rules also count per the Go spec, but ASCII covers the
  // overwhelming majority of real-world Go.
  const first = name.charAt(0);
  if (first >= 'A' && first <= 'Z') return 'exported';
  return 'module-local';
}

function extractParams(
  node: Parser.SyntaxNode,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  return collectParamEntries(params);
}

// Closures share the same parameters field shape as function_declaration.
const extractClosureParams = extractParams;

function collectParamEntries(
  params: Parser.SyntaxNode,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of params.namedChildren) {
    if (child.type !== 'parameter_declaration' && child.type !== 'variadic_parameter_declaration') {
      continue;
    }
    const isRest = child.type === 'variadic_parameter_declaration';
    // A parameter_declaration may bind multiple names to one type:
    // `func f(a, b int)` produces a single declaration node with two
    // `name` children. Iterate the named identifiers.
    for (const inner of child.namedChildren) {
      if (inner.type === 'identifier') {
        out.push({ name: inner.text, optional: false, rest: isRest });
      }
    }
  }
  return out;
}

// ── body normalization ────────────────────────────────────────────

interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

function digestGoBody(text: string): BodyDigest {
  const normalized = normalizeWhitespace(stripGoComments(text));
  return { hash: sha256(normalized), size: normalized.length };
}

// Synthetic bodies (module-init) use the same normalization as real
// bodies; alias for self-documenting call sites.
const digestSyntheticBody = digestGoBody;

/**
 * Strip Go line comments (// to end of line) and block comments
 * (slash-star ... star-slash). Go does NOT support nested block
 * comments. Preserve string literals (both interpreted `"…"` and raw
 * backtick `…`); preserve rune literals.
 */
function stripGoComments(text: string): string {
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
    const c = text[i];
    if (c === '"') {
      const block = consumeInterpretedString(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === '`') {
      const block = consumeRawString(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === "'") {
      const block = consumeRuneLiteral(text, i);
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
  // Go block comments do NOT nest. Scan to the first `*/`.
  let i = start;
  while (i < text.length) {
    if (text.slice(i, i + 2) === '*/') return i + 2;
    i++;
  }
  /* v8 ignore next */
  return i;
}

function consumeInterpretedString(
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

function consumeRawString(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // Raw strings span across newlines and have no escape sequences.
  let i = start + 1;
  let buf = '`';
  while (i < text.length) {
    if (text[i] === '`') {
      buf += '`';
      i++;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

function consumeRuneLiteral(
  text: string,
  start: number,
): { readonly text: string; readonly index: number } {
  // A rune literal is a `'`, then either a single char or an escape
  // sequence (`\n`, `A`, `\xff`), then a closing `'`. Walk to the
  // next unescaped `'` within a small window.
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
  return TEST_FILE_NAME_RE.test(rel);
}

function isGeneratedFile(rel: string): boolean {
  return GENERATED_PATH_RE.test(rel);
}
