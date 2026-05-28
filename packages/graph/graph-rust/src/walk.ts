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

import type { RustParsedFile, RustParsedProject } from './parse.js';
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
const TEST_FILE_NAME_RE = /(?:^|\/)[^/]*_test\.rs$/;
const GENERATED_PATH_RE = /\btarget\/|\.generated\./;

export function walkProject(input: WalkInput<RustParsedProject>): WalkOutput {
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
  file: RustParsedFile,
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

  // Phase 4 (DEC-498): walk top-level `use` (and `extern crate`)
  // declarations as dependency sites. Owner is the file's synthesized
  // module-init occurrence.
  collectDependencySites(file, moduleInit.bodyHash, dependencySites);

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

/**
 * Walk a Rust file's top-level `use_declaration` and `extern_crate_declaration`
 * nodes; emit one `DependencySiteRecord` per terminal path. Phase 4 of
 * opensip's substrate consolidation (DEC-498).
 *
 * `use_declaration`'s single named child is one of:
 *
 *   - `scoped_identifier` — e.g. `use std::collections::HashMap;` →
 *     emit specifier `'std::collections::HashMap'`.
 *   - `identifier` — e.g. `use foo;` → emit specifier `'foo'`.
 *   - `use_as_clause` — e.g. `use std::collections::HashMap as Map;` →
 *     extract the underlying path (LHS of `as`); alias is dropped.
 *   - `scoped_use_list` — grouped form. Combines a path prefix with a
 *     `use_list` of one-or-more children. Each child may itself be a
 *     `scoped_use_list` (nested groups), `scoped_identifier`,
 *     `identifier`, `use_as_clause`, `use_wildcard`, or `self` (bare
 *     `self` inside the list refers to the prefix itself).
 *   - `use_list` — bare `{a, b}` without prefix (rare at top level —
 *     usually appears under a `scoped_use_list`).
 *   - `use_wildcard` — e.g. `use std::prelude::v1::*;` → emit specifier
 *     ending in `::*`; resolver treats globs as unresolved (no single
 *     module target). Documented v1 limitation.
 *
 * `extern_crate_declaration` — legacy Rust 2015-edition form (mostly
 * gone in 2018+). `extern crate foo;` → emit specifier `'foo'`.
 *
 * Visibility modifiers (`pub use ...`) and the `use`/`extern`/`crate`
 * keywords are ignored — we emit one dep site per import target.
 *
 * Out of scope at v1:
 *   - Conditional imports inside function bodies (`fn f() { use foo; }`).
 *     Rust permits these; the walker only inspects file top-level.
 *   - `use ::absolute::path;` (leading `::`) — uncommon; would be
 *     emitted with the leading separator stripped.
 */
function collectDependencySites(
  file: RustParsedFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of file.tree.rootNode.namedChildren) {
    if (stmt.type === 'use_declaration') {
      collectFromUseDeclaration(stmt, file, moduleInitHash, out);
    } else if (stmt.type === 'extern_crate_declaration') {
      collectFromExternCrate(stmt, file, moduleInitHash, out);
    }
  }
}

function collectFromUseDeclaration(
  decl: Parser.SyntaxNode,
  file: RustParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  // The path-bearing child is the last named child (skipping
  // visibility_modifier on `pub use ...`).
  const body = pickUsePathNode(decl);
  if (!body) return;
  const line = decl.startPosition.row + 1;
  const column = decl.startPosition.column;
  emitFromUseSegment(body, [], file, ownerHash, line, column, out);
}

function pickUsePathNode(decl: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // Walk named children in reverse, taking the first non-visibility node.
  for (let i = decl.namedChildCount - 1; i >= 0; i--) {
    const c = decl.namedChild(i);
    if (!c) continue;
    if (c.type === 'visibility_modifier') continue;
    return c;
  }
  /* v8 ignore next */
  return null;
}

/**
 * Walk one path-bearing sub-node of a use declaration. `prefix` is the
 * canonical path segments accumulated from enclosing `scoped_use_list`
 * groups. The function dispatches by node type and emits one
 * `DependencySiteRecord` per terminal path.
 */
function emitFromUseSegment(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  switch (node.type) {
    case 'scoped_identifier':
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self': {
      emitFromPathLeaf(node, prefix, file, ownerHash, line, column, out);
      return;
    }
    case 'use_as_clause': {
      emitFromUseAsClause(node, prefix, file, ownerHash, line, column, out);
      return;
    }
    case 'use_wildcard': {
      emitFromUseWildcard(node, prefix, file, ownerHash, line, column, out);
      return;
    }
    case 'scoped_use_list': {
      emitFromScopedUseList(node, prefix, file, ownerHash, line, column, out);
      return;
    }
    case 'use_list': {
      emitFromUseList(node, prefix, file, ownerHash, line, column, out);
      return;
    }
    /* v8 ignore start */
    default: {
      emitFromUnknownUseShape(node, prefix, file, ownerHash, line, column, out);
      return;
    }
    /* v8 ignore stop */
  }
}

function emitFromPathLeaf(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  const segments = decodePathSegments(node);
  pushDepSite([...prefix, ...segments], node, file, ownerHash, line, column, out);
}

function emitFromUseAsClause(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  // `<path> as <alias>` — emit the underlying path only.
  const inner = node.namedChild(0);
  if (inner) {
    emitFromUseSegment(inner, prefix, file, ownerHash, line, column, out);
  }
}

function emitFromUseWildcard(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  // `<path>::*` — single emission with `*` as the trailing segment.
  // The grammar nests the path under the wildcard (single named
  // child); we append `'*'` to the segments.
  const inner = node.namedChild(0);
  const segments = inner ? decodePathSegments(inner) : [];
  pushDepSite([...prefix, ...segments, '*'], node, file, ownerHash, line, column, out);
}

function emitFromScopedUseList(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  // `<path>::{<list>}` — combine path + each list child.
  // Children order: a path-like (identifier / scoped_identifier /
  // crate / super / self) then a `use_list`.
  const split = splitScopedUseListChildren(node);
  if (split.list === null) return;
  const newPrefix = [...prefix, ...split.pathSegs];
  emitUseListItems(split.list, newPrefix, file, ownerHash, line, column, out);
}

function splitScopedUseListChildren(
  node: Parser.SyntaxNode,
): { readonly pathSegs: readonly string[]; readonly list: Parser.SyntaxNode | null } {
  let pathSegs: readonly string[] = [];
  let list: Parser.SyntaxNode | null = null;
  for (const c of node.namedChildren) {
    if (c.type === 'use_list') {
      list = c;
    } else if (list === null) {
      pathSegs = decodePathSegments(c);
    }
  }
  return { pathSegs, list };
}

function emitFromUseList(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  // Bare `{a, b}` — uncommon at top level; descend with current prefix.
  emitUseListItems(node, prefix, file, ownerHash, line, column, out);
}

function emitUseListItems(
  list: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  for (const item of list.namedChildren) {
    if (item.type === 'self') {
      // `use a::b::{self, X}` — `self` refers to the parent path,
      // i.e. emit the prefix itself.
      pushDepSite([...prefix], item, file, ownerHash, line, column, out);
      continue;
    }
    emitFromUseSegment(item, prefix, file, ownerHash, line, column, out);
  }
}

/* v8 ignore start */
function emitFromUnknownUseShape(
  node: Parser.SyntaxNode,
  prefix: readonly string[],
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  // Unknown shape — defensive fallback: emit raw text as a single
  // segment so downstream attribution still has something to show.
  const text = node.text;
  if (text.length > 0) {
    pushDepSite([...prefix, text], node, file, ownerHash, line, column, out);
  }
}
/* v8 ignore stop */

/**
 * Decode a path-bearing node into canonical `::`-separated segments.
 * Accepts `scoped_identifier` (recursive), `identifier`, `crate`,
 * `super`, `self`. Returns `[]` for unknown shapes (caller skips).
 */
function decodePathSegments(node: Parser.SyntaxNode): readonly string[] {
  if (node.type === 'identifier' || node.type === 'crate' || node.type === 'super' || node.type === 'self') {
    return [node.text];
  }
  if (node.type === 'scoped_identifier') {
    const out: string[] = [];
    for (const c of node.namedChildren) {
      out.push(...decodePathSegments(c));
    }
    return out;
  }
  /* v8 ignore next */
  return [];
}

function pushDepSite(
  segments: readonly string[],
  node: Parser.SyntaxNode,
  file: RustParsedFile,
  ownerHash: string,
  line: number,
  column: number,
  out: DependencySiteRecord[],
): void {
  if (segments.length === 0) {
    /* v8 ignore next */
    return;
  }
  out.push({
    nodeRef: node,
    sourceFileRef: file,
    ownerHash,
    specifier: segments.join('::'),
    line,
    column,
  });
}

function collectFromExternCrate(
  decl: Parser.SyntaxNode,
  file: RustParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  // `extern crate <name>;` or `extern crate <name> as <alias>;`. The
  // crate name is the first identifier (not the `crate` keyword token).
  for (const c of decl.namedChildren) {
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
