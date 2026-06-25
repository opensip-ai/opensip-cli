// @fitness-ignore-file unbounded-memory -- reads only the project's `go.mod` manifest (for the module path); bounded by standard Go module metadata size. Source-file reads go through `readSourceFileGuarded` in the shared parse driver.
/**
 * Go resolveCallSites — name-based catalog lookup.
 *
 * Tree-sitter has no symbol table, so we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Four shapes matter:
 *      - `foo(args)`              — identifier; target is `foo`.
 *      - `obj.Method(args)`       — selector_expression; target is the
 *                                   trailing `field_identifier`.
 *      - `pkg.Func(args)`         — same shape; AST-indistinguishable
 *                                   from method calls without a type
 *                                   checker. We use the field name.
 *      - `Type{}.method(args)`    — selector_expression on a
 *                                   composite_literal; we still extract
 *                                   the field name.
 *
 *   2. Look up matching catalog entries by simple name. Confidence
 *      ladder mirrors graph-python (no receiver-type narrowing in
 *      tree-sitter-go because the receiver type can't be known without
 *      type info):
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'`
 *
 * Per I-4: this function does NOT mutate the input catalog.
 */

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { logger } from '@opensip-cli/core';
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '@opensip-cli/graph';
import { buildNameIndex, sameLanguageFileFilter } from '@opensip-cli/graph-adapter-common';

import type { GoParsedFile, GoParsedProject } from './parse.js';
import type {
  Catalog,
  CallEdge,
  DependencyEdge,
  DependencySiteRecord,
  EdgeSink,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

// @graph-ignore-next-line graph:near-duplicate-function-body -- language adapters keep position helpers local because each reads parser-specific node locations.
function goPosition(
  node: Node,
  file: GoParsedFile,
): {
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

// @graph-ignore-next-line graph:near-duplicate-function-body -- call-site resolution loops are intentionally parallel across language adapters for adapter-local grammar handling.
export function resolveCallSites(input: ResolveInput<GoParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:go' });
  // Same-language only: on the exact build the merged catalog holds every
  // language, so a Go call must not pin a same-named TS/Python/… occurrence.
  const byName = buildNameIndex(input.catalog.functions, sameLanguageFileFilter('go'));
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink: EdgeSink = { edgesByOwner, stats };

  for (const r of input.callSites) {
    const node = r.nodeRef as Node;
    const file = r.sourceFileRef as GoParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(goPosition(node, file), r.ownerHash, r.childHash, sink);
      continue;
    }
    pushCallEdge(node, file, r.ownerHash, byName, sink);
  }

  const finalStats: ResolutionStats = {
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
  };
  logger.info({ evt: 'graph.edges.complete', module: 'graph:edges:go', ...finalStats });

  // Phase 4 (DEC-498): resolve dependency sites if any. Mirrors the
  // Python adapter's resolveDependencies pattern, adapted to Go's
  // `go.mod`-mediated module-path resolution.
  const dependenciesByOwner =
    input.dependencySites && input.dependencySites.length > 0
      ? resolveDependencies(input.dependencySites, input.catalog, input.projectDirAbs)
      : undefined;

  return dependenciesByOwner === undefined
    ? { edgesByOwner, stats: finalStats }
    : { edgesByOwner, dependenciesByOwner, stats: finalStats };
}

/**
 * Resolve Go import sites to target module-init bodyHashes. Imports
 * resolving to a same-module source file (via `go.mod`'s declared
 * module path) map to that package directory's module-init occurrences;
 * imports resolving to stdlib (`fmt`, `os`, …), third-party (`github.com/
 * external/lib`), or unresolvable shapes produce unresolved
 * `DependencyEdge` entries with `to: []` and the raw specifier carried
 * in `specifier` for downstream attribution.
 *
 * Resolution rules:
 *
 *   1. Read `go.mod` from `projectDirAbs`. The first `module <path>`
 *      line declares the module's own path. If `go.mod` is missing or
 *      unparseable, ALL imports go unresolved.
 *
 *   2. Build a `filePath → module-init bodyHash` map from the catalog.
 *
 *   3. For each dependency site, classify the import path:
 *      - **Internal** — starts with `<module-path>/` (or equals it):
 *        strip the module-path prefix to get a project-relative
 *        package-directory path. `to` is every catalog module-init
 *        occurrence whose `filePath` lives inside that directory (Go
 *        packages can span multiple files — `pkg/foo/foo.go`,
 *        `pkg/foo/helpers.go`).
 *      - **External** — doesn't start with module path (stdlib like
 *        `fmt`, third-party like `github.com/x/y`, or relative-style
 *        `./pkg` / `../foo` not common in modern Go): `to: []`.
 *
 *   4. Blank imports (`_ "path"`) and dot imports (`. "path"`) resolve
 *      the same as plain imports — the prefix only affects Go's import
 *      semantics, not the dependency target.
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */
function resolveDependencies(
  sites: readonly DependencySiteRecord[],
  catalog: Catalog,
  projectDirAbs: string,
): ReadonlyMap<string, readonly DependencyEdge[]> {
  const modulePath = readGoModulePath(projectDirAbs);

  // Build filePath → module-init bodyHash map. Catalog occurrences carry
  // project-relative POSIX filePath; module-init kind is filtered.
  const moduleInitByFilePath = new Map<string, string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (o.kind === 'module-init') moduleInitByFilePath.set(o.filePath, o.bodyHash);
    }
  }

  const out = new Map<string, DependencyEdge[]>();
  for (const site of sites) {
    const to = resolveGoImportPath(site.specifier, modulePath, moduleInitByFilePath);
    const edge: DependencyEdge = {
      to,
      line: site.line,
      column: site.column,
      specifier: site.specifier,
    };
    const existing = out.get(site.ownerHash);
    if (existing === undefined) {
      out.set(site.ownerHash, [edge]);
    } else {
      existing.push(edge);
    }
  }
  return out;
}

/**
 * Extract the module path from `go.mod`. We do a line-grep on `^module
 * <path>$` rather than parse the full grammar — replace directives,
 * vendor blocks, retract statements, and toolchain lines are all
 * out-of-scope for v1. Returns `null` when `go.mod` is missing or no
 * `module` line is found.
 *
 * Edge cases NOT handled (deferred): `replace` directives that retarget
 * a module path, `go.work` multi-module workspaces (each module's own
 * `go.mod` is read independently in this v1).
 */
function readGoModulePath(projectDirAbs: string): string | null {
  let content: string;
  try {
    content = readFileSync(join(projectDirAbs, 'go.mod'), 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    // Skip comments and blank lines.
    if (line.length === 0 || line.startsWith('//')) continue;
    // `module <path>` — capture the bare path. Quoted form `module "<path>"`
    // is legal in go.mod; strip optional quotes.
    const match = /^module\s+("([^"]+)"|(\S+))\s*$/.exec(line);
    if (match) return match[2] ?? match[3] ?? null;
  }
  return null;
}

/**
 * Resolve one Go import path to its target module-init bodyHash(es).
 * Returns `[]` when the import is external (stdlib, third-party, or
 * unresolvable relative).
 *
 * Multi-file packages: a single import like `"github.com/me/myproj/pkg/foo"`
 * corresponds to the DIRECTORY `pkg/foo/`, which may contain `foo.go`,
 * `helpers.go`, etc. The returned `to` array includes every matching
 * module-init bodyHash — the engine model's polymorphic-targets case.
 */
function resolveGoImportPath(
  specifier: string,
  modulePath: string | null,
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  if (modulePath === null) return [];

  // Internal: import path equals or is rooted under the module path.
  if (specifier === modulePath) {
    return collectGoPackageMembers('', moduleInitByFilePath);
  }
  const prefix = `${modulePath}/`;
  if (!specifier.startsWith(prefix)) return [];

  // The package-directory path is the import path with the module
  // prefix stripped. Forward-slashes are canonical in both go import
  // paths and catalog filePaths.
  const packageDir = specifier.slice(prefix.length);
  return collectGoPackageMembers(packageDir, moduleInitByFilePath);
}

/**
 * Enumerate every module-init in the catalog whose filePath sits
 * directly inside `packageDir`. Go's package = directory, with `.go`
 * files at the directory's top level (subdirectories are separate
 * packages). Excludes `_test.go` files from production-import targets?
 * NO — the catalog already carries every walked `.go`, and `_test.go`
 * files belong to the same package directory at the AST level; we
 * include them as edge targets and let downstream rules filter by
 * `inTestFile` if needed.
 */
function collectGoPackageMembers(
  packageDir: string,
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  // packageDir is empty when the module path itself is imported. In
  // that case, the package members live directly at the project root.
  const out: string[] = [];
  for (const [filePath, hash] of moduleInitByFilePath) {
    if (!filePath.endsWith('.go')) continue;
    const dir = posix.dirname(filePath);
    const normalizedDir = dir === '.' ? '' : dir;
    if (normalizedDir === packageDir) out.push(hash);
  }
  return out;
}

// @graph-ignore-next-line graph:near-duplicate-function-body -- Go/Java/Python edge sinks intentionally mirror the shared resolution contract while extracting language-specific call targets.
function pushCallEdge(
  node: Node,
  file: GoParsedFile,
  ownerHash: string,
  byName: ReadonlyMap<string, readonly string[]>,
  sink: EdgeSink,
): void {
  const { edgesByOwner, stats } = sink;
  stats.totalCallSites++;
  const target = extractCallTargetName(node);
  const pos = goPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge = buildGoCallEdge(target, byName, {
    line: pos.line,
    column: pos.column,
    text: truncated,
    discarded,
  });
  appendEdge(edgesByOwner, ownerHash, edge);
  stats.apply(edge);
}

interface CallEdgeLoc {
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly discarded: boolean;
}

// @graph-ignore-next-line graph:near-duplicate-function-body -- call-edge builders are kept adapter-local so resolution confidence labels can evolve per language.
function buildGoCallEdge(
  target: string | null,
  byName: ReadonlyMap<string, readonly string[]>,
  loc: CallEdgeLoc,
): CallEdge {
  if (target === null) {
    return { to: [], ...loc, resolution: 'unknown', confidence: 'low' };
  }
  const matches = byName.get(target);
  if (!matches || matches.length === 0) {
    return { to: [], ...loc, resolution: 'unknown', confidence: 'low' };
  }
  if (matches.length === 1) {
    return { to: [...matches], ...loc, resolution: 'static', confidence: 'medium' };
  }
  return { to: [...matches], ...loc, resolution: 'method-dispatch', confidence: 'low' };
}

/**
 * Decode a `call_expression` node's target into a simple name. Returns
 * null when we don't recognize the shape (e.g. type assertion call,
 * map index call) — those become unresolved edges.
 */
function extractCallTargetName(node: Node): string | null {
  // tree-sitter-go `call_expression` has a `function` field for the callee.
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    return field ? field.text : null;
  }
  // Other shapes (index_expression, parenthesized_expression, etc.) —
  // not common for the call-graph rules we ship today.
  return null;
}

/**
 * The call's return value is discarded when the call expression is
 * the entire expression of an expression_statement. Go's `go foo()`
 * and `defer foo()` statements also discard the return.
 */
function isReturnValueDiscarded(node: Node): boolean {
  let parent: Node | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression') {
      parent = parent.parent;
      continue;
    }
    return (
      parent.type === 'expression_statement' ||
      parent.type === 'go_statement' ||
      parent.type === 'defer_statement'
    );
  }
  /* v8 ignore next */
  return false;
}
