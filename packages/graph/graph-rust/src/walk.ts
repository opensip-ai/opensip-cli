// @fitness-ignore-file file-length-limit -- tree-sitter language walker spanning AST cases; cohesive grammar-driven dispatch already split (body-digest, walk-metadata extracted by earlier pass), further split would fragment per-node logic.
// @fitness-ignore-file context-mutation -- `ctx: WalkCtx` here is a function-scoped traversal accumulator (callSites array, occurrence sink, parser refs) threaded through the AST walk, NOT a shared request/execution context. `ctx.callSites.push(...)` is the intended local-accumulator append. The check's `LOCAL_DECLARATION_PATTERNS` heuristic doesn't see it because `ctx` arrives as a typed parameter, not via `const ctx = …`.
// @fitness-ignore-file performance-anti-patterns -- spread used to flatten AST child nodes during tree-sitter walk; bounded by node arity at each step
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

import { relative, sep } from 'node:path';

import {
  childrenOf,
  makeFileClassifier,
  namedChildrenOf,
  nameOf,
  record,
  runWalk,
  synthesizeModuleInit as buildModuleInit,
} from '@opensip-tools/graph-adapter-common';

import { digestRustBody, digestSyntheticBody } from './body-digest.js';

import type { RustParsedFile, RustParsedProject } from './parse.js';
import type {
  CallSiteRecord,
  DependencySiteRecord,
  FunctionOccurrence,
  WalkInput,
  WalkOutput,
} from '@opensip-tools/graph';
import type { Node } from 'web-tree-sitter';


const TEST_PATH_RE = /(?:^|\/)tests?\//;
const TEST_FILE_NAME_RE = /(?:^|\/)[^/]*_test\.rs$/;
const GENERATED_PATH_RE = /\btarget\/|\.generated\./;

const { isTestFile, isGeneratedFile } = makeFileClassifier({
  testRe: TEST_FILE_NAME_RE,
  generatedRe: GENERATED_PATH_RE,
  testPathRe: TEST_PATH_RE,
});

export { isTestFile };

export function walkProject(input: WalkInput<RustParsedProject>): WalkOutput {
  return runWalk({ input, walkFile });
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

  const qualifiedBase = filePathProjectRel.replace(/\.rs$/, '').split('/').join('::');
  const moduleInit = buildModuleInit({
    file,
    filePathProjectRel,
    inTestFile,
    definedInGenerated,
    digestSyntheticBody,
    qualifiedName: `${qualifiedBase}::<module-init>`,
  });
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

  for (const child of childrenOf(file.tree.rootNode)) visit(child, initialFrame, ctx);
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
  for (const stmt of namedChildrenOf(file.tree.rootNode)) {
    if (stmt.type === 'use_declaration') {
      collectFromUseDeclaration(stmt, file, moduleInitHash, out);
    } else if (stmt.type === 'extern_crate_declaration') {
      collectFromExternCrate(stmt, file, moduleInitHash, out);
    }
  }
}

/**
 * Invariant context threaded through the `use`-declaration walker family
 * (`emitFrom*` / `emitUseListItems` / `pushDepSite`). Built once per use
 * declaration; only the current sub-`node` and the accumulated path `prefix`
 * vary per call, so they stay positional while these five ride in the context.
 */
interface UseSiteContext {
  readonly file: RustParsedFile;
  readonly ownerHash: string;
  readonly line: number;
  readonly column: number;
  readonly out: DependencySiteRecord[];
}

function collectFromUseDeclaration(
  decl: Node,
  file: RustParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  // The path-bearing child is the last named child (skipping
  // visibility_modifier on `pub use ...`).
  const body = pickUsePathNode(decl);
  if (!body) return;
  const ctx: UseSiteContext = {
    file,
    ownerHash,
    line: decl.startPosition.row + 1,
    column: decl.startPosition.column,
    out,
  };
  emitFromUseSegment(body, [], ctx);
}

function pickUsePathNode(decl: Node): Node | null {
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
  node: Node,
  prefix: readonly string[],
  ctx: UseSiteContext,
): void {
  switch (node.type) {
    case 'scoped_identifier':
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self': {
      emitFromPathLeaf(node, prefix, ctx);
      return;
    }
    case 'use_as_clause': {
      emitFromUseAsClause(node, prefix, ctx);
      return;
    }
    case 'use_wildcard': {
      emitFromUseWildcard(node, prefix, ctx);
      return;
    }
    case 'scoped_use_list': {
      emitFromScopedUseList(node, prefix, ctx);
      return;
    }
    case 'use_list': {
      emitFromUseList(node, prefix, ctx);
      return;
    }
    /* v8 ignore start */
    default: {
      emitFromUnknownUseShape(node, prefix, ctx);
      return;
    }
    /* v8 ignore stop */
  }
}

function emitFromPathLeaf(node: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  const segments = decodePathSegments(node);
  pushDepSite([...prefix, ...segments], node, ctx);
}

function emitFromUseAsClause(node: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  // `<path> as <alias>` — emit the underlying path only.
  const inner = node.namedChild(0);
  if (inner) {
    emitFromUseSegment(inner, prefix, ctx);
  }
}

function emitFromUseWildcard(node: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  // `<path>::*` — single emission with `*` as the trailing segment.
  // The grammar nests the path under the wildcard (single named
  // child); we append `'*'` to the segments.
  const inner = node.namedChild(0);
  const segments = inner ? decodePathSegments(inner) : [];
  pushDepSite([...prefix, ...segments, '*'], node, ctx);
}

function emitFromScopedUseList(node: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  // `<path>::{<list>}` — combine path + each list child.
  // Children order: a path-like (identifier / scoped_identifier /
  // crate / super / self) then a `use_list`.
  const split = splitScopedUseListChildren(node);
  if (split.list === null) return;
  const newPrefix = [...prefix, ...split.pathSegs];
  emitUseListItems(split.list, newPrefix, ctx);
}

function splitScopedUseListChildren(
  node: Node,
): { readonly pathSegs: readonly string[]; readonly list: Node | null } {
  let pathSegs: readonly string[] = [];
  let list: Node | null = null;
  for (const c of namedChildrenOf(node)) {
    if (c.type === 'use_list') {
      list = c;
    } else if (list === null) {
      pathSegs = decodePathSegments(c);
    }
  }
  return { pathSegs, list };
}

function emitFromUseList(node: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  // Bare `{a, b}` — uncommon at top level; descend with current prefix.
  emitUseListItems(node, prefix, ctx);
}

function emitUseListItems(list: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  for (const item of namedChildrenOf(list)) {
    if (item.type === 'self') {
      // `use a::b::{self, X}` — `self` refers to the parent path,
      // i.e. emit the prefix itself.
      pushDepSite([...prefix], item, ctx);
      continue;
    }
    emitFromUseSegment(item, prefix, ctx);
  }
}

/* v8 ignore start */
function emitFromUnknownUseShape(node: Node, prefix: readonly string[], ctx: UseSiteContext): void {
  // Unknown shape — defensive fallback: emit raw text as a single
  // segment so downstream attribution still has something to show.
  const text = node.text;
  if (text.length > 0) {
    pushDepSite([...prefix, text], node, ctx);
  }
}
/* v8 ignore stop */

/**
 * Decode a path-bearing node into canonical `::`-separated segments.
 * Accepts `scoped_identifier` (recursive), `identifier`, `crate`,
 * `super`, `self`. Returns `[]` for unknown shapes (caller skips).
 */
function decodePathSegments(node: Node): readonly string[] {
  if (node.type === 'identifier' || node.type === 'crate' || node.type === 'super' || node.type === 'self') {
    return [node.text];
  }
  if (node.type === 'scoped_identifier') {
    const out: string[] = [];
    for (const c of namedChildrenOf(node)) {
      out.push(...decodePathSegments(c));
    }
    return out;
  }
  /* v8 ignore next */
  return [];
}

function pushDepSite(segments: readonly string[], node: Node, ctx: UseSiteContext): void {
  if (segments.length === 0) {
    /* v8 ignore next */
    return;
  }
  ctx.out.push({
    nodeRef: node,
    sourceFileRef: ctx.file,
    ownerHash: ctx.ownerHash,
    specifier: segments.join('::'),
    line: ctx.line,
    column: ctx.column,
  });
}

function collectFromExternCrate(
  decl: Node,
  file: RustParsedFile,
  ownerHash: string,
  out: DependencySiteRecord[],
): void {
  // `extern crate <name>;` or `extern crate <name> as <alias>;`. The
  // crate name is the first identifier (not the `crate` keyword token).
  for (const c of namedChildrenOf(decl)) {
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

function visit(node: Node, frame: Frame, ctx: WalkCtx): void {
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
  for (const child of childrenOf(node)) visit(child, frame, ctx);
}

function visitImpl(node: Node, frame: Frame, ctx: WalkCtx): void {
  const typeName = implTargetName(node);
  // Don't emit a function for the `impl` block itself — its body is a
  // declaration list whose function_items are emitted as methods. Keep
  // module-init as the owner; descend with impl context.
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingImpl: typeName };
  for (const child of childrenOf(node)) visit(child, childFrame, ctx);
}

function visitFunction(node: Node, frame: Frame, ctx: WalkCtx): void {
  const occ = buildFunctionOccurrence(node, frame, ctx);
  if (!occ) return;
  record(ctx.out, occ);
  const childFrame: Frame = { ownerHash: occ.bodyHash, enclosingImpl: null };
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
    visit(body, { ownerHash: occ.bodyHash, enclosingImpl: null }, ctx);
  }
  return true;
}

function buildFunctionOccurrence(
  node: Node,
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
  node: Node,
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

// ── helpers ───────────────────────────────────────────────────────

function implTargetName(node: Node): string {
  const ty = node.childForFieldName('type');
  if (ty) return ty.text;
  /* v8 ignore start -- defensive: tree-sitter-rust always exposes the `type`
     field on a well-formed impl_item, so these fallbacks fire only on
     malformed/partial ASTs that valid Rust source doesn't produce. */
  // Fallback: first type_identifier child.
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

// Closures use the same `parameters` field as `function_item`; an alias
// keeps call-site names readable without duplicating the body
// (sonarjs/no-identical-functions).
const extractClosureParams = extractParams;

function collectParamEntries(params: Node): readonly { name: string; optional: boolean; rest: boolean }[] {
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
    /* v8 ignore start -- defensive: function_item / impl-method params arrive as
       `self_parameter` / `parameter` nodes; the bare-`identifier` (closure-shaped)
       and unexpected-node-kind fallbacks guard AST shapes the walk's param paths
       don't reach. */
    case 'identifier': {
      // Closure params often appear as bare identifiers.
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
  // Attributes precede the function_item as siblings inside the parent.
  // tree-sitter-rust models them as `attribute_item` nodes preceding
  // the function_item, OR (more commonly in practice) as
  // `attribute_item` children of the function_item's parent that
  // appear before the function_item by source position.
  for (const c of childrenOf(node)) {
    if (c.type === 'attribute_item' || c.type === 'inner_attribute_item') {
      out.push(c.text.trim());
    }
  }
  // Also scan preceding siblings (attribute_item is structurally a
  // sibling of function_item under most parents).
  const parent = node.parent;
  if (parent) {
    for (const sib of parent.children) {
      // web-tree-sitter returns fresh Node wrappers per access, so the
      // `node` handle passed in is never reference-identical to its twin
      // in `parent.children`. Compare by stable byte offset instead of
      // `===` (which would never match → scan past `node` and wrongly
      // attribute later siblings' attributes to it).
      if (sib === null || sib.startIndex >= node.startIndex) break;
      if (sib.type === 'attribute_item' || sib.type === 'inner_attribute_item') {
        out.push(sib.text.trim());
      }
    }
  }
  // Dedupe.
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

// Body digest helpers (stripRustComments, normalizeWhitespace, sha256,
// digestRustBody, digestSyntheticBody, BodyDigest) live in body-digest.ts.

function classifyRustFunctionKind(
  name: string,
  enclosingImpl: string | null,
): FunctionOccurrence['kind'] {
  if (enclosingImpl === null) return 'function-declaration';
  if (name === 'new') return 'constructor';
  return 'method';
}

