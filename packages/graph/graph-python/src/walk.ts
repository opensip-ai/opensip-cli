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

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';

import type { PythonParsedFile, PythonParsedProject } from './parse.js';
import type {
  CallSiteRecord,
  DependencySiteRecord,
  FunctionOccurrence,
  ParseError,
  WalkInput,
  WalkOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

const TEST_PATH_RE = /(?:^|\/)tests?\//;
const TEST_FILE_NAME_RE = /(?:^|\/)test_[^/]+\.py$|_test\.py$/;
const GENERATED_PATH_RE = /\bdist\/|\bbuild\/|\.generated\./;

export function walkProject(input: WalkInput<PythonParsedProject>): WalkOutput {
  const occurrences: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const callSites: CallSiteRecord[] = [];
  const dependencySites: DependencySiteRecord[] = [];
  const parseErrors: ParseError[] = [];

  // Iterate files in stable order so I-1 (determinism) holds.
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
  file: PythonParsedFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
  callSites: CallSiteRecord[],
  dependencySites: DependencySiteRecord[],
): void {
  const filePathProjectRel = relative(projectDirAbs, absPath).split(sep).join('/');
  const inTestFile = isTestFile(filePathProjectRel);
  const definedInGenerated = isGeneratedFile(filePathProjectRel);

  const moduleInit = synthesizeModuleInit(file, filePathProjectRel, inTestFile, definedInGenerated);
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

  for (const child of file.tree.rootNode.children) visit(child, initialFrame, ctx);
}

/**
 * Walk a Python file's top-level statements for `import_statement` and
 * `import_from_statement` nodes; emit one `DependencySiteRecord` per
 * imported module (not per imported name). The owner is the file's
 * synthesized module-init occurrence (every file has exactly one).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498). The emitted
 * `specifier` preserves the raw dotted module path as written, including
 * any leading dots for relative imports (`'.foo'`, `'..pkg.bar'`).
 *
 * Out of scope at v1:
 *   - Wildcard `from foo import *` is treated like any other from-import:
 *     one dep site on the source module (`foo`); the `*` semantics
 *     (re-exports) are not modelled.
 *   - `__all__` semantics, dynamic `__import__` / `importlib.import_module`,
 *     and conditional / nested imports inside function bodies (only
 *     top-level imports are emitted).
 */
function collectDependencySites(
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of file.tree.rootNode.namedChildren) {
    if (stmt.type === 'import_statement') {
      collectFromImportStatement(stmt, file, moduleInitHash, out);
    } else if (stmt.type === 'import_from_statement') {
      collectFromImportFromStatement(stmt, file, moduleInitHash, out);
    }
  }
}

/**
 * `import foo`, `import foo.bar`, `import foo as f`, `import a, b.c, d`.
 * Each name child is either a `dotted_name` or an `aliased_import` whose
 * `name` field is a `dotted_name`. Emits one dep site per top-level
 * comma-separated target.
 */
function collectFromImportStatement(
  stmt: Parser.SyntaxNode,
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const child of stmt.namedChildren) {
    let dotted: Parser.SyntaxNode | null = null;
    if (child.type === 'dotted_name') {
      dotted = child;
    } else if (child.type === 'aliased_import') {
      const nameField = child.childForFieldName('name');
      if (nameField?.type === 'dotted_name') dotted = nameField;
    }
    if (!dotted) continue;
    pushDependencySite(stmt, file, moduleInitHash, dotted.text, out);
  }
}

/**
 * `from foo import x`, `from foo.bar import a, b`, `from . import x`,
 * `from .pkg import y`, `from ..parent import z`.
 *
 * The module-name field encodes the source module:
 *   - `dotted_name`     → absolute import (`from foo.bar import …`)
 *   - `relative_import` → leading dot(s) + optional `dotted_name`
 *
 * For `from . import name`, the relative_import has only dots (no
 * trailing dotted_name); the specifier is the leading-dot string
 * (e.g. `'.'`) — the *imported names* are themselves modules to resolve.
 * To preserve the one-dep-site-per-imported-module rule for this shape,
 * we walk the `name` field too and emit one site per imported name,
 * each carrying the prefix-dots + name (e.g. `.sibling`).
 *
 * For all other relative shapes (`from .pkg import x`, `from ..pkg.sub
 * import y`), the relative_import already carries the module path; we
 * emit ONE dep site with the raw relative-import text as specifier.
 */
function collectFromImportFromStatement(
  stmt: Parser.SyntaxNode,
  file: PythonParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  const moduleNameField = stmt.childForFieldName('module_name');
  if (!moduleNameField) return;

  if (moduleNameField.type === 'dotted_name') {
    pushDependencySite(stmt, file, moduleInitHash, moduleNameField.text, out);
    return;
  }

  if (moduleNameField.type === 'relative_import') {
    const prefix = relativeImportPrefix(moduleNameField);
    const innerDotted = relativeImportInnerDotted(moduleNameField);
    if (innerDotted !== null) {
      // `from .pkg import x` — one site, specifier = '.pkg'
      pushDependencySite(stmt, file, moduleInitHash, prefix + innerDotted, out);
      return;
    }
    // `from . import sibling, other` — one site PER imported name,
    // specifier = `.sibling`, `.other`.
    for (const named of stmt.namedChildren) {
      if (named === moduleNameField) continue;
      let dotted: Parser.SyntaxNode | null = null;
      if (named.type === 'dotted_name') {
        dotted = named;
      } else if (named.type === 'aliased_import') {
        const nameField = named.childForFieldName('name');
        if (nameField?.type === 'dotted_name') dotted = nameField;
      }
      if (!dotted) continue;
      pushDependencySite(stmt, file, moduleInitHash, prefix + dotted.text, out);
    }
  }
}

function relativeImportPrefix(node: Parser.SyntaxNode): string {
  // The `import_prefix` child carries the leading dots as raw text.
  for (const child of node.children) {
    if (child.type === 'import_prefix') return child.text;
  }
  /* v8 ignore next */
  return '';
}

function relativeImportInnerDotted(node: Parser.SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === 'dotted_name') return child.text;
  }
  return null;
}

function pushDependencySite(
  stmt: Parser.SyntaxNode,
  file: PythonParsedFile,
  ownerHash: string,
  specifier: string,
  out: DependencySiteRecord[],
): void {
  out.push({
    nodeRef: stmt,
    sourceFileRef: file,
    ownerHash,
    specifier,
    line: stmt.startPosition.row + 1,
    column: stmt.startPosition.column,
  });
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

function visit(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
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
  for (const child of node.children) visit(child, frame, ctx);
}

function visitClass(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
  const className = nameOf(node) ?? '<anon-class>';
  // Don't emit a function for the class itself — Python classes are
  // declarations whose top-level statements run at module load. Keep
  // the module-init as the owner; descend with class context for
  // nested function_definitions to be tagged as methods.
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingClass: className };
  for (const child of node.children) visit(child, childFrame, ctx);
}

function visitFunction(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): void {
  const occ = visitFunctionDefinition(
    node,
    ctx.file,
    ctx.filePathProjectRel,
    frame.enclosingClass,
    ctx.inTestFile,
    ctx.definedInGenerated,
  );
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash, enclosingClass: null };
  const body = node.childForFieldName('body');
  if (body) {
    for (const child of body.children) visit(child, childFrame, ctx);
  }
}

function visitLambdaNode(node: Parser.SyntaxNode, frame: Frame, ctx: WalkCtx): boolean {
  const occ = visitLambda(node, ctx.file, ctx.filePathProjectRel, ctx.inTestFile, ctx.definedInGenerated);
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
  node: Parser.SyntaxNode,
  file: PythonParsedFile,
  filePathProjectRel: string,
  enclosingClass: string | null,
  inTestFile: boolean,
  definedInGenerated: boolean,
): FunctionOccurrence | null {
  const name = nameOf(node) ?? '<anon-fn>';
  const digest = digestPythonBody(file.source.slice(node.startIndex, node.endIndex));
  const kind = classifyFunctionKind(name, enclosingClass);
  const qualifiedBase = filePathProjectRel.replace(/\.py$/, '').split('/').join('.');
  const qualifiedName = enclosingClass === null
    ? `${qualifiedBase}.${name}`
    : `${qualifiedBase}.${enclosingClass}.${name}`;
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
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

function visitLambda(
  node: Parser.SyntaxNode,
  file: PythonParsedFile,
  filePathProjectRel: string,
  inTestFile: boolean,
  definedInGenerated: boolean,
): FunctionOccurrence | null {
  const digest = digestPythonBody(file.source.slice(node.startIndex, node.endIndex));
  const startLine = node.startPosition.row + 1;
  const startCol = node.startPosition.column;
  const simpleName = `<arrow:${filePathProjectRel}:${String(startLine)}:${String(startCol)}>`;
  const qualifiedBase = filePathProjectRel.replace(/\.py$/, '').split('/').join('.');
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
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

function synthesizeModuleInit(
  file: PythonParsedFile,
  filePathProjectRel: string,
  inTestFile: boolean,
  definedInGenerated: boolean,
): FunctionOccurrence {
  // Hash the file's top-level statement-text concatenation. Mirrors
  // lang-typescript's synthesizeModuleInit shape.
  const root = file.tree.rootNode;
  const topLevelText = root.children.map((c) => file.source.slice(c.startIndex, c.endIndex)).join('\n');
  const digest = digestSyntheticBody(`${filePathProjectRel}\n${topLevelText}`);
  const simpleName = `<module-init:${filePathProjectRel}>`;
  const qualifiedBase = filePathProjectRel.replace(/\.py$/, '').split('/').join('.');
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

function extractParams(node: Parser.SyntaxNode): readonly { name: string; optional: boolean; rest: boolean }[] {
  return extractParamsFromField(node, 'parameters');
}

function extractParamsFromField(
  node: Parser.SyntaxNode,
  fieldName: string,
): readonly { name: string; optional: boolean; rest: boolean }[] {
  const params = node.childForFieldName(fieldName);
  if (!params) return [];
  const out: { name: string; optional: boolean; rest: boolean }[] = [];
  for (const child of params.namedChildren) {
    const param = extractParam(child);
    if (param) out.push(param);
  }
  return out;
}

function extractParam(child: Parser.SyntaxNode): { name: string; optional: boolean; rest: boolean } | null {
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

function extractDecorators(node: Parser.SyntaxNode): readonly string[] {
  // tree-sitter-python wraps a function_definition in a `decorated_definition`
  // node when decorators are present. The decorators are siblings of the
  // function_definition inside that wrapper.
  if (node.parent?.type !== 'decorated_definition') return [];
  /* v8 ignore start */
  const out: string[] = [];
  for (const child of node.parent.namedChildren) {
    if (child.type === 'decorator') {
      // Decorator text is `@expr`; trim the leading `@`.
      const text = child.text.trim();
      out.push(text.startsWith('@') ? text.slice(1) : text);
    }
  }
  return out;
  /* v8 ignore stop */
}

// ── body normalization ────────────────────────────────────────────

interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

function digestPythonBody(text: string): BodyDigest {
  const normalized = normalizePythonBody(text);
  return { hash: sha256(normalized), size: normalized.length };
}

function digestSyntheticBody(text: string): BodyDigest {
  const normalized = normalizeWhitespace(stripPythonComments(text));
  return { hash: sha256(normalized), size: normalized.length };
}

/**
 * Strip Python `#` comments and leading-of-body docstrings, then
 * collapse whitespace. Docstring detection is line-oriented and
 * conservative: a line containing only a triple-quoted string at the
 * top of the body is removed. This is good enough for the v1 contract;
 * a parse-tree-driven version is a follow-up if FP rates demand it.
 */
function normalizePythonBody(text: string): string {
  return normalizeWhitespace(stripPythonComments(stripLeadingDocstring(text)));
}

function stripPythonComments(text: string): string {
  // Walk character-by-character, respecting string literals (so `#`
  // inside a string is preserved). Python strings are wrapped by `'`,
  // `"`, or triple-quoted variants.
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      i = skipToEndOfLine(text, i);
      continue;
    }
    if (c === '"' || c === "'") {
      const next = consumeStringLiteral(text, i, c);
      out += next.text;
      i = next.index;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* v8 ignore start */
function skipToEndOfLine(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function consumeStringLiteral(
  text: string,
  start: number,
  quote: string,
): { readonly text: string; readonly index: number } {
  const triple = text.slice(start, start + 3) === `${quote}${quote}${quote}`;
  const close = triple ? `${quote}${quote}${quote}` : quote;
  let i = start + (triple ? 3 : 1);
  let buf = text.slice(start, i);
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text.slice(i, i + close.length) === close) {
      buf += close;
      i += close.length;
      break;
    }
    buf += text[i];
    i++;
  }
  return { text: buf, index: i };
}
/* v8 ignore stop */

function stripLeadingDocstring(text: string): string {
  // Match an optional whitespace prefix followed by a triple-quoted
  // string, optionally followed by a newline. Conservative — only
  // handles the common case at the start of the function/module body.
  const match = /^\s*(?:[ru]?(?:'''[\s\S]*?'''|"""[\s\S]*?"""))\s*\n/i.exec(text);
  if (match) return text.slice(match[0].length);
  return text;
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
