/**
 * Rust walkProject — emit FunctionOccurrences + CallSiteRecords.
 *
 * Lands in PR 6 of plan docs/plans/10-graph-language-pluggability.md.
 *
 * Identifies the callable shapes:
 *
 *   - `function_item` outside any `impl_item`        → 'function-declaration'
 *   - `function_item` inside an `impl_item`'s body  → 'method'
 *     - `enclosingClass` = the impl's target type (e.g. `Foo` in `impl Foo`)
 *   - `closure_expression`                          → 'arrow'
 *   - one synthetic `<module-init>` per file owning top-level non-fn
 *     items (`use`, `const`, `static`, attribute_item, etc.)
 *
 * Body hashing: sha256 of normalized body text. Normalization:
 *   1. Strip line comments (`// …` to end-of-line).
 *   2. Strip block comments (slash-star ... star-slash, including
 *      nested ones — Rust supports nested block comments, rare though).
 *   3. Collapse whitespace.
 *   String literals are preserved (their content is part of behavior).
 *
 * Call-site records:
 *   - `call_expression` — every Rust function/method call.
 *     The resolver decodes `function`/`method`/`std::fs::read` shapes.
 *   - `macro_invocation` — Rust macros (`println!`, `vec!`, etc.).
 *     Treated as calls so side-effect rules can detect `println!`.
 *   - 'creation' edges — for each `closure_expression` nested inside
 *     a parent function/method/module-init, emit a creation edge so
 *     reachability flows through closures even when the runtime
 *     dispatch site is unresolvable. Mirror of lang-typescript's
 *     `isInlineCallable` rule applied to Rust closures.
 *
 * Test detection:
 *   - File-level: `tests/` directory or `*_test.rs`.
 *   - Function-level: `#[test]` or `#[cfg(test)]` attributes mark
 *     individual functions as test code. We honor the attribute and
 *     set `inTestFile: true` for that occurrence regardless of file
 *     path. NOTE: this means a non-test-file function tagged
 *     `#[test]` is treated as a test. Rust's test conventions allow
 *     this (you can have `#[cfg(test)] mod tests` in any module).
 */

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';

import type { CallSiteRecord, WalkInput, WalkOutput } from '../lang-adapter/types.js';
import type { FunctionOccurrence, ParseError } from '../types.js';
import type { RustParsedFile, RustParsedProject } from './parse.js';
import type Parser from 'tree-sitter';

const TEST_PATH_RE = /(?:^|\/)tests?\//;
const TEST_FILE_NAME_RE = /(?:^|\/)[^/]*_test\.rs$/;
const GENERATED_PATH_RE = /\btarget\/|\.generated\./;

export function walkProject(input: WalkInput<RustParsedProject>): WalkOutput {
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
  file: RustParsedFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
  callSites: CallSiteRecord[],
): void {
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);

  const moduleInit = synthesizeModuleInit(file, filePathProjectRel, inTestFile, definedInGenerated);
  record(out, moduleInit);

  const ctx: WalkCtx = {
    file,
    filePathProjectRel,
    fileInTestFile: inTestFile,
    definedInGenerated,
    out,
    callSites,
  };
  const initialFrame: Frame = { ownerHash: moduleInit.bodyHash, enclosingImpl: null };

  for (const child of file.tree.rootNode.children) visit(child, initialFrame, ctx);
}

interface Frame {
  readonly ownerHash: string;
  /** Set inside an `impl` block's body. Used to tag `function_item`s as methods. */
  readonly enclosingImpl: string | null;
}

interface WalkCtx {
  readonly file: RustParsedFile;
  readonly filePathProjectRel: string;
  readonly fileInTestFile: boolean;
  readonly definedInGenerated: boolean;
  readonly out: Record<string, FunctionOccurrence[]>;
  readonly callSites: CallSiteRecord[];
}

function visit(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
  if (node.type === 'impl_item') {
    visitImpl(node, frame, ctx);
    return;
  }
  if (node.type === 'function_item') {
    visitFunction(node, frame, ctx);
    return;
  }
  if (node.type === 'closure_expression' && visitClosure(node, frame, ctx)) {
    return;
  }
  if (node.type === 'call_expression' || node.type === 'macro_invocation') {
    ctx.callSites.push({
      nodeRef: node,
      sourceFileRef: ctx.file,
      ownerHash: frame.ownerHash,
      kind: 'call',
    });
  }
  for (const child of node.children) visit(child, frame, ctx);
}

function visitImpl(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
  const typeName = implTargetName(node);
  // Don't emit a function for the `impl` block itself — its body is a
  // declaration list whose function_items are emitted as methods. Keep
  // module-init as the owner; descend with impl context.
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingImpl: typeName };
  for (const child of node.children) visit(child, childFrame, ctx);
}

function visitFunction(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
  const occ = buildFunctionOccurrence(node, frame, ctx);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash, enclosingImpl: null };
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
    visit(body, { ownerHash: occ.bodyHash, enclosingImpl: null }, ctx);
  }
  return true;
}

function buildFunctionOccurrence(
  node: Parser.SyntaxNode,
  frame: Frame,
  ctx: WalkCtx,
): FunctionOccurrence | null {
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestRustBody(ctx.file.source.slice(node.startIndex, node.endIndex));
  const isTest = ctx.fileInTestFile || hasTestAttribute(node);
  const kind = classifyRustFunctionKind(name, frame.enclosingImpl);
  const qualifiedBase = ctx.filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  const qualifiedName = frame.enclosingImpl === null
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

function buildClosureOccurrence(
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
): FunctionOccurrence | null {
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

function synthesizeModuleInit(
  file: RustParsedFile,
  filePathProjectRel: string,
  inTestFile: boolean,
  definedInGenerated: boolean,
): FunctionOccurrence {
  const root = file.tree.rootNode;
  const topLevelText = root.children.map((c) => file.source.slice(c.startIndex, c.endIndex)).join('\n');
  const digest = digestSyntheticBody(`${filePathProjectRel}\n${topLevelText}`);
  const simpleName = `<module-init:${filePathProjectRel}>`;
  const qualifiedBase = filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName,
    qualifiedName: `${qualifiedBase}::<module-init>`,
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

function implTargetName(node: Parser.SyntaxNode): string {
  const ty = node.childForFieldName('type');
  if (ty) return ty.text;
  // Fallback: first type_identifier child.
  for (const c of node.namedChildren) {
    if (c.type === 'type_identifier' || c.type === 'generic_type') return c.text;
  }
  return '<anon-impl>';
}

function classifyVisibility(node: Parser.SyntaxNode): FunctionOccurrence['visibility'] {
  for (const c of node.children) {
    if (c.type === 'visibility_modifier') return 'exported';
  }
  return 'module-local';
}

function extractParams(node: Parser.SyntaxNode): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName('parameters');
  if (!params) return [];
  return collectParamEntries(params);
}

// Closures use the same `parameters` field as `function_item`; an alias
// keeps call-site names readable without duplicating the body
// (sonarjs/no-identical-functions).
const extractClosureParams = extractParams;

function collectParamEntries(params: Parser.SyntaxNode): readonly { name: string; optional: boolean; rest: boolean }[] {
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of params.namedChildren) {
    const param = decodeParam(child);
    if (param) out.push(param);
  }
  return out;
}

function decodeParam(child: Parser.SyntaxNode): { name: string; optional: boolean; rest: boolean } | null {
  switch (child.type) {
    case 'self_parameter': {
      return { name: 'self', optional: false, rest: false };
    }
    case 'parameter': {
      const pat = child.childForFieldName('pattern') ?? child.namedChild(0);
      if (!pat) return null;
      return { name: pat.text, optional: false, rest: false };
    }
    case 'identifier': {
      // Closure params often appear as bare identifiers.
      return { name: child.text, optional: false, rest: false };
    }
    default: {
      return null;
    }
  }
}

function extractAttributes(node: Parser.SyntaxNode): readonly string[] {
  const out: string[] = [];
  // Attributes precede the function_item as siblings inside the parent.
  // tree-sitter-rust models them as `attribute_item` nodes preceding
  // the function_item, OR (more commonly in practice) as
  // `attribute_item` children of the function_item's parent that
  // appear before the function_item by source position.
  for (const c of node.children) {
    if (c.type === 'attribute_item' || c.type === 'inner_attribute_item') {
      out.push(c.text.trim());
    }
  }
  // Also scan preceding siblings (attribute_item is structurally a
  // sibling of function_item under most parents).
  const parent = node.parent;
  if (parent) {
    for (const sib of parent.children) {
      if (sib === node) break;
      if (sib.type === 'attribute_item' || sib.type === 'inner_attribute_item') {
        out.push(sib.text.trim());
      }
    }
  }
  // Dedupe.
  return [...new Set(out)];
}

function hasTestAttribute(node: Parser.SyntaxNode): boolean {
  const attrs = extractAttributes(node);
  for (const a of attrs) {
    if (a.includes('#[test]')) return true;
    /* v8 ignore next */
    if (a.includes('cfg(test)')) return true;
  }
  return false;
}

// ── body normalization ────────────────────────────────────────────

interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

function digestRustBody(text: string): BodyDigest {
  const normalized = normalizeWhitespace(stripRustComments(text));
  return { hash: sha256(normalized), size: normalized.length };
}

// Synthetic bodies (module-init) use the same normalization as real
// bodies; an alias keeps the name at the call site self-documenting
// without duplicating the implementation (sonarjs/no-identical-functions).
const digestSyntheticBody = digestRustBody;

function classifyRustFunctionKind(
  name: string,
  enclosingImpl: string | null,
): FunctionOccurrence['kind'] {
  if (enclosingImpl === null) return 'function-declaration';
  if (name === 'new') return 'constructor';
  return 'method';
}

/**
 * Strip Rust line comments (// to end of line) and block comments
 * (slash-star ... star-slash, including nested forms — Rust's grammar
 * permits nesting). Preserve string literals (their content matters).
 */
function stripRustComments(text: string): string {
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
      const block = consumeStringLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
    }
    if (c === "'" && isCharLiteral(text, i)) {
      /* v8 ignore start */
      const block = consumeCharLiteral(text, i);
      out += block.text;
      i = block.index;
      continue;
      /* v8 ignore stop */
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
  // Rust supports nested block comments. Track depth.
  let i = start;
  let depth = 1;
  while (i < text.length && depth > 0) {
    const next2 = text.slice(i, i + 2);
    if (next2 === '/*') {
      depth++;
      i += 2;
      continue;
    }
    if (next2 === '*/') {
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

function consumeStringLiteral(text: string, start: number): { readonly text: string; readonly index: number } {
  let i = start + 1;
  let buf = '"';
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      /* v8 ignore start */
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
      /* v8 ignore stop */
    }
    if (text[i] === '"') {
      buf += '"';
      i++;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}

/* v8 ignore start */
function isCharLiteral(text: string, i: number): boolean {
  // Heuristic: a `'` followed by a single char or escape, then another
  // `'`, with nothing alphanumeric immediately following the closing
  // `'` (otherwise it's a lifetime: `'static`, `'a`).
  if (text[i] !== "'") return false;
  const slice = text.slice(i, i + 4);
  // `'a'`, `'\n'`, `'\\''` patterns. Lifetimes don't have a closing
  // `'`, so we look for one within ~3 chars.
  if (slice.length < 3) return false;
  const escape = slice[1] === '\\';
  const closeIdx = escape ? 3 : 2;
  return slice[closeIdx] === "'";
}

function consumeCharLiteral(text: string, start: number): { readonly text: string; readonly index: number } {
  // Already verified by isCharLiteral.
  const escape = text[start + 1] === '\\';
  const len = escape ? 4 : 3;
  return { text: text.slice(start, start + len), index: start + len };
}
/* v8 ignore stop */

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
