/**
 * Rust resolveCallSites — name-based catalog lookup with `impl`-block
 * receiver-type context.
 *
 * Tree-sitter has no symbol table; we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Five shapes matter:
 *      - `foo(args)`              — call target is `foo`.
 *      - `obj.method(args)`       — field_expression call target is
 *                                   the trailing `field_identifier`.
 *      - `Type::method(args)`     — scoped_identifier; target is the
 *                                   trailing identifier.
 *      - `path::to::fn(args)`     — same scoped_identifier shape.
 *      - `name!(args)`            — macro_invocation target is the
 *                                   leading identifier.
 *
 *   2. Look up matching catalog entries. For method calls
 *      (`obj.method`), we narrow by `enclosingClass` if the receiver
 *      type is statically known (literal, simple-typed local). The
 *      narrow is best-effort, NOT type-aware — we don't track types
 *      across statements. With the narrow:
 *      - 1 method match in the receiver's impl  → 'high' confidence
 *        ... actually no — even with narrowing, tree-sitter never
 *        produces 'high' for ordinary calls, because the receiver
 *        type itself is name-based. We use 'medium' for the
 *        narrowed case and 'low' for the un-narrowed case.
 *      Confidence ladder for plain calls:
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'`
 *
 *   Macros are emitted as edges with `resolution: 'unknown'` and
 *   `confidence: 'low'` since macros are rarely first-party functions
 *   in the catalog. Their value to the call-graph is letting
 *   `no-side-effect-path` see `println!` calls; the edge text carries
 *   the macro name for that match.
 *
 * Per I-4: this function does NOT mutate the input catalog.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '@opensip-tools/core';
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '@opensip-tools/graph';

import type { RustParsedFile, RustParsedProject } from './parse.js';
import type {
  Catalog,
  CallEdge,
  DependencyEdge,
  DependencySiteRecord,
  FunctionOccurrence,
  MutableStats,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-tools/graph';
import type Parser from 'tree-sitter';

interface NameIndex {
  /** All occurrences keyed by simple name (excludes module-init / arrow synthetics). */
  readonly all: ReadonlyMap<string, readonly FunctionOccurrence[]>;
  /** Methods narrowed by their `enclosingClass`. Key = enclosingClass + '::' + simpleName. */
  readonly methods: ReadonlyMap<string, readonly FunctionOccurrence[]>;
}

function rustPosition(node: Parser.SyntaxNode, file: RustParsedFile): {
  readonly line: number;
  readonly column: number;
  readonly text: string;
} {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    text: file.source.slice(node.startIndex, node.endIndex),
  };
}

export function resolveCallSites(input: ResolveInput<RustParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:rust' });
  const index = buildIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const r of input.callSites) {
    const node = r.nodeRef as Parser.SyntaxNode;
    const file = r.sourceFileRef as RustParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(node, file, r.ownerHash, r.childHash, edgesByOwner, stats, rustPosition);
      continue;
    }
    pushCallEdge(node, file, r.ownerHash, index, edgesByOwner, stats);
  }

  const finalStats: ResolutionStats = {
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
  };
  logger.info({ evt: 'graph.edges.complete', module: 'graph:edges:rust', ...finalStats });

  // Phase 4 (DEC-498): resolve dependency sites if any. Mirrors the
  // Python adapter's relative-import handling, adapted to Rust's
  // `crate::` / `super::` / `self::` path prefixes and Cargo's
  // `src/lib.rs` / `src/main.rs` / `src/foo.rs` / `src/foo/mod.rs`
  // module layout conventions.
  const dependenciesByOwner =
    input.dependencySites && input.dependencySites.length > 0
      ? resolveDependencies(input.dependencySites, input.catalog, input.projectDirAbs)
      : undefined;

  return dependenciesByOwner === undefined
    ? { edgesByOwner, stats: finalStats }
    : { edgesByOwner, dependenciesByOwner, stats: finalStats };
}

/**
 * Resolve Rust `use`-declaration sites to target module-init bodyHashes.
 *
 * Rust resolution rules (mirrors Python's relative-import logic, with
 * keyword prefixes `crate` / `super` / `self` rather than leading dots):
 *
 *   1. Parse `Cargo.toml` from `projectDirAbs` to find the package name
 *      (the `name = "<n>"` line inside `[package]`). If unavailable,
 *      ALL `crate::` / `<package-name>::` imports are treated as
 *      unresolvable.
 *   2. Derive a Rust module path for every catalog file:
 *        - `src/lib.rs` / `src/main.rs`        → `crate`
 *        - `src/foo.rs` / `src/foo/mod.rs`     → `crate::foo`
 *        - `src/foo/bar.rs` / `src/foo/bar/mod.rs` → `crate::foo::bar`
 *      Build a `module-path → bodyHash` map.
 *   3. For each dependency site, classify the specifier:
 *        - Glob (`…::*`)                       → `to: []` (documented
 *                                                v1 limitation; globs
 *                                                cross multiple modules).
 *        - `crate::…`                          → look up by walking
 *                                                from the longest
 *                                                matching module prefix
 *                                                back to `crate`.
 *        - `<package-name>::…`                 → rewrite to `crate::…`
 *                                                and resolve.
 *        - `super::…` / `self::…`              → rewrite to absolute via
 *                                                importer's module path.
 *        - Anything else (`std::*`, `core::*`,
 *          `alloc::*`, `serde::*`, etc.)       → `to: []` (stdlib /
 *                                                third-party).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */
function resolveDependencies(
  sites: readonly DependencySiteRecord[],
  catalog: Catalog,
  projectDirAbs: string,
): ReadonlyMap<string, readonly DependencyEdge[]> {
  const packageName = readCargoPackageName(projectDirAbs);

  // Build module-path → bodyHash map AND the inverse filePath → module
  // path so we can rewrite `super::` / `self::` relative to the importer.
  const moduleInitByModulePath = new Map<string, string>();
  const modulePathByFilePath = new Map<string, string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.kind !== 'module-init') continue;
      const modulePath = filePathToRustModulePath(o.filePath);
      if (modulePath === null) continue;
      moduleInitByModulePath.set(modulePath, o.bodyHash);
      modulePathByFilePath.set(o.filePath, modulePath);
    }
  }

  const out = new Map<string, DependencyEdge[]>();
  for (const site of sites) {
    const importerFilePath = filePathOfOwner(catalog, site.ownerHash);
    const importerModulePath =
      importerFilePath === null ? null : (modulePathByFilePath.get(importerFilePath) ?? null);
    const to = resolveRustUseSpecifier(
      site.specifier,
      packageName,
      importerModulePath,
      moduleInitByModulePath,
    );
    const edge: DependencyEdge = {
      to,
      line: site.line,
      column: site.column,
      specifier: site.specifier,
    };
    const existing = out.get(site.ownerHash);
    if (existing === undefined) {out.set(site.ownerHash, [edge]);}
    else {existing.push(edge);}
  }
  return out;
}

/**
 * Look up the importer's filePath from the catalog via owner bodyHash.
 * Needed for `super::` / `self::` rewriting since the catalog already
 * carries the project-relative filePath.
 */
function filePathOfOwner(catalog: Catalog, ownerHash: string): string | null {
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.bodyHash === ownerHash) return o.filePath;
    }
  }
  /* v8 ignore next */
  return null;
}

/**
 * Extract the package name from `Cargo.toml`'s `[package]` section.
 * Strategy: line-grep for `name = "<value>"` inside the `[package]`
 * section header. We intentionally do NOT pull in a TOML parser — this
 * is a v1 limitation. Returns `null` when `Cargo.toml` is missing,
 * unparseable, or has no `[package] name = …`.
 *
 * Edge cases NOT handled (deferred):
 *   - `[workspace]`-only roots without a `[package]` (Cargo workspace
 *     virtual-manifest); we'd need to recurse into `members = […]`.
 *   - `[package] name = 'single-quoted'` (TOML allows this; rare).
 *   - Multi-line table arrays / nested tables that re-open `[package]`.
 *   - Dev-dependencies / feature flags — irrelevant to resolution.
 */
function readCargoPackageName(projectDirAbs: string): string | null {
  let content: string;
  try {
    content = readFileSync(join(projectDirAbs, 'Cargo.toml'), 'utf8');
  } catch {
    return null;
  }
  let inPackage = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      // New section header — `[package]` enters, anything else exits.
      inPackage = /^\[package\]\s*$/.test(line);
      continue;
    }
    if (!inPackage) continue;
    const match = /^name\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Map a project-relative POSIX filePath to its Rust crate module path.
 * Returns `null` when the file isn't recognizable as a crate module
 * (e.g. lives outside `src/`, or doesn't follow the canonical layout).
 *
 * Conventions handled:
 *   - `src/lib.rs`           → `crate`
 *   - `src/main.rs`          → `crate`
 *   - `src/<n>.rs`           → `crate::<n>`
 *   - `src/<n>/mod.rs`       → `crate::<n>`
 *   - `src/<a>/<b>.rs`       → `crate::<a>::<b>`
 *   - `src/<a>/<b>/mod.rs`   → `crate::<a>::<b>`
 *
 * Files outside `src/` (e.g. `tests/it.rs`, `examples/foo.rs`,
 * `benches/bench.rs`) return `null` — they're separate compilation
 * units, not part of the library/binary crate's module tree.
 */
function filePathToRustModulePath(filePath: string): string | null {
  if (!filePath.endsWith('.rs')) return null;
  if (!filePath.startsWith('src/') && filePath !== 'src.rs') return null;
  // Strip `src/` prefix.
  const rel = filePath.slice('src/'.length);
  if (rel === 'lib.rs' || rel === 'main.rs') return 'crate';
  // Strip trailing `.rs`.
  const noExt = rel.slice(0, -'.rs'.length);
  // Treat `…/mod` (from `…/mod.rs`) as the parent directory itself.
  const segments = noExt.split('/');
  if (segments.at(-1) === 'mod') segments.pop();
  if (segments.length === 0) return 'crate';
  return ['crate', ...segments].join('::');
}

/**
 * Resolve one Rust `use`-specifier to its target module-init
 * bodyHash(es). Returns `[]` for stdlib, third-party, globs, and
 * unresolvable relative paths.
 *
 * Multi-target: at v1 every match is a single module (Rust modules
 * aren't directory-spanning the way Go packages are), so the returned
 * array is either `[]` or a single hash. The `readonly string[]` shape
 * is kept for engine-model symmetry.
 */
function resolveRustUseSpecifier(
  specifier: string,
  packageName: string | null,
  importerModulePath: string | null,
  moduleInitByModulePath: ReadonlyMap<string, string>,
): readonly string[] {
  // Glob — documented v1 limitation. Skip resolution.
  if (specifier.endsWith('::*') || specifier === '*') return [];

  const segments = specifier.split('::');
  if (segments.length === 0 || segments[0] === undefined) return [];

  // Rewrite the head segment into an absolute `crate::…` path.
  const absolute = rewriteToAbsoluteModulePath(segments, packageName, importerModulePath);
  if (absolute === null) return [];

  return lookupRustModule(absolute, moduleInitByModulePath);
}

/**
 * Rewrite a `use`-path's segments into the absolute `crate::…` form
 * suitable for catalog lookup. Returns `null` when the path is external
 * (stdlib, third-party crate other than the host package).
 */
function rewriteToAbsoluteModulePath(
  segments: readonly string[],
  packageName: string | null,
  importerModulePath: string | null,
): readonly string[] | null {
  const head = segments[0];
  if (head === undefined) /* v8 ignore next */ return null;
  if (head === 'crate') {
    return segments;
  }
  if (head === 'self') {
    // `self::x::y` — current module + remainder.
    if (importerModulePath === null) return null;
    const current = importerModulePath.split('::');
    return [...current, ...segments.slice(1)];
  }
  if (head === 'super') {
    // Count consecutive leading `super` segments and walk up that many.
    if (importerModulePath === null) return null;
    let supers = 0;
    while (segments[supers] === 'super') supers++;
    const current = importerModulePath.split('::');
    // Strip `supers` trailing module segments from the current path.
    // Note: `current` always starts with `crate`, so we must not strip
    // past index 1.
    const remaining = current.slice(0, Math.max(1, current.length - supers));
    return [...remaining, ...segments.slice(supers)];
  }
  // External crate reference, possibly the host package referring to
  // itself by name (`<package-name>::foo` ≡ `crate::foo`).
  if (packageName !== null && head === toRustIdent(packageName)) {
    return ['crate', ...segments.slice(1)];
  }
  return null;
}

/**
 * Look up a fully-qualified Rust module path against the catalog. The
 * specifier may name a module OR an item inside a module (a type, fn,
 * const, etc.). Tree-sitter can't distinguish the two, so we walk from
 * the longest module-prefix match toward `crate`, returning the first
 * hit.
 */
function lookupRustModule(
  segments: readonly string[],
  moduleInitByModulePath: ReadonlyMap<string, string>,
): readonly string[] {
  const cur = [...segments];
  while (cur.length > 0) {
    const key = cur.join('::');
    const hash = moduleInitByModulePath.get(key);
    if (hash !== undefined) return [hash];
    cur.pop();
  }
  return [];
}

/**
 * Cargo package names allow `-` but Rust identifiers don't — Cargo
 * substitutes `-` → `_` when synthesizing the crate's Rust-visible
 * name. Mirror that.
 */
function toRustIdent(packageName: string): string {
  return packageName.replaceAll('-', '_');
}


function buildIndex(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
): NameIndex {
  const all = new Map<string, FunctionOccurrence[]>();
  const methods = new Map<string, FunctionOccurrence[]>();
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    if (name.startsWith('<')) continue;
    const list: FunctionOccurrence[] = all.get(name) ?? [];
    for (const o of occs) {
      list.push(o);
      if (o.enclosingClass !== null) {
        const key = `${o.enclosingClass}::${o.simpleName}`;
        const ml: FunctionOccurrence[] = methods.get(key) ?? [];
        ml.push(o);
        methods.set(key, ml);
      }
    }
    all.set(name, list);
  }
  return { all, methods };
}

function pushCallEdge(
  node: Parser.SyntaxNode,
  file: RustParsedFile,
  ownerHash: string,
  index: NameIndex,
  edgesByOwner: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
  stats.totalCallSites++;
  const target = decodeCallTarget(node);
  const pos = rustPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge = resolveTarget(target, index, {
    line: pos.line,
    column: pos.column,
    text: truncated,
    discarded,
  });
  stats.apply(edge);
  appendEdge(edgesByOwner, ownerHash, edge);
}

interface CallTarget {
  /** The simple name of the called function/method/macro. */
  readonly name: string;
  /** Receiver type if statically known (e.g. `Foo::bar` → `'Foo'`). */
  readonly receiverType: string | null;
  /** True for `name!(...)` macro invocations. */
  readonly isMacro: boolean;
}

function decodeCallTarget(node: Parser.SyntaxNode): CallTarget | null {
  if (node.type === 'macro_invocation') {
    const m = node.childForFieldName('macro') ?? node.namedChild(0);
    if (!m) return null;
    return { name: m.text.split('::').pop() ?? m.text, receiverType: null, isMacro: true };
  }
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') {
    return { name: fn.text, receiverType: null, isMacro: false };
  }
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    if (!field) return null;
    return { name: field.text, receiverType: null, isMacro: false };
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name') ?? fn.namedChild(fn.namedChildCount - 1);
    if (!name) return null;
    const path = fn.childForFieldName('path');
    const receiver = decodeReceiverPath(path);
    return { name: name.text, receiverType: receiver, isMacro: false };
  }
  return null;
}

function decodeReceiverPath(path: Parser.SyntaxNode | null): string | null {
  if (!path) return null;
  // For `Type::name`, path is a `type_identifier` or `identifier`.
  // For `mod::Type::name`, path is a `scoped_identifier` whose own
  // trailing component is the type. We walk down the path looking for
  // the last `type_identifier` / `identifier`.
  if (path.type === 'type_identifier' || path.type === 'identifier') return path.text;
  if (path.type === 'scoped_identifier') {
    const inner = path.childForFieldName('name') ?? path.namedChild(path.namedChildCount - 1);
    return inner ? inner.text : null;
  }
  return null;
}

function resolveTarget(
  target: CallTarget | null,
  index: NameIndex,
  loc: { readonly line: number; readonly column: number; readonly text: string; readonly discarded: boolean },
): CallEdge {
  if (target === null) {
    return { to: [], line: loc.line, column: loc.column, resolution: 'unknown', confidence: 'low', text: loc.text, discarded: loc.discarded };
  }
  // Macros: tag the edge for side-effect detection but mark unresolved.
  // The edge text carries `name!` so rules can match against the
  // primitive list (e.g. `println!`).
  if (target.isMacro) {
    return {
      to: [],
      line: loc.line,
      column: loc.column,
      resolution: 'unknown',
      confidence: 'low',
      text: `${target.name}! ${loc.text}`,
      discarded: loc.discarded,
    };
  }
  // Receiver-narrowed lookup if we have a Type::method shape.
  if (target.receiverType !== null) {
    const narrowed = index.methods.get(`${target.receiverType}::${target.name}`);
    if (narrowed && narrowed.length > 0) {
      const hashes = narrowed.map((o) => o.bodyHash);
      return {
        to: hashes,
        line: loc.line,
        column: loc.column,
        resolution: hashes.length === 1 ? 'static' : 'method-dispatch',
        confidence: 'medium',
        text: loc.text,
        discarded: loc.discarded,
      };
    }
    // Receiver was named but no method — fall through to broad name lookup.
  }
  const matches = index.all.get(target.name);
  if (!matches || matches.length === 0) {
    return { to: [], line: loc.line, column: loc.column, resolution: 'unknown', confidence: 'low', text: loc.text, discarded: loc.discarded };
  }
  if (matches.length === 1) {
    const only = matches[0];
    if (!only) {
      return { to: [], line: loc.line, column: loc.column, resolution: 'unknown', confidence: 'low', text: loc.text, discarded: loc.discarded };
    }
    return {
      to: [only.bodyHash],
      line: loc.line,
      column: loc.column,
      resolution: 'static',
      confidence: 'medium',
      text: loc.text,
      discarded: loc.discarded,
    };
  }
  return {
    to: matches.map((o) => o.bodyHash),
    line: loc.line,
    column: loc.column,
    resolution: 'method-dispatch',
    confidence: 'low',
    text: loc.text,
    discarded: loc.discarded,
  };
}

/**
 * The call's return value is discarded when the call expression is the
 * entire expression of an expression_statement.
 */
function isReturnValueDiscarded(node: Parser.SyntaxNode): boolean {
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  return false;
}
