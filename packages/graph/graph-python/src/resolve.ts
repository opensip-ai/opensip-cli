/**
 * Python resolveCallSites — name-based catalog lookup.
 *
 * Tree-sitter has no symbol table, so we resolve by simple name. For
 * each call site:
 *
 *   1. Decode the called expression. Three shapes matter:
 *      - `foo(args)`               → call target is identifier `foo`
 *      - `obj.method(args)`        → call target is attribute `method`
 *      - `mod.submod.fn(args)`     → call target is attribute `fn`
 *      Other shapes (`(lambda)()`, subscript calls) are treated as
 *      unresolved.
 *
 *   2. Look up matching catalog entries by simple name. Confidence
 *      ladder:
 *      - 0 matches  → `to: []`, resolution `'unknown'`,    confidence `'low'`
 *      - 1 match    → `to: [hash]`, resolution `'static'`, confidence `'medium'`
 *      - N matches  → `to: [allHashes]`, resolution `'method-dispatch'`,
 *                     confidence `'low'` (multiple candidates means we
 *                     can't disambiguate without a symbol table)
 *
 * Confidence is mostly `'medium'`, never `'high'` — that's the
 * intrinsic price of name-based resolution. The plan §6 fidelity table
 * documents this (`orphan-subtree`: medium for tree-sitter adapters).
 *
 * Creation edges (lambda) emit a static high-confidence edge directly,
 * mirroring lang-typescript's semantics.
 *
 * Per I-4: this function does NOT mutate the input catalog. It builds
 * a `bodyHash → CallEdge[]` map and returns it.
 */

import { dirname, posix } from 'node:path';

import { logger } from '@opensip-tools/core';
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '@opensip-tools/graph';
import { buildNameIndex } from '@opensip-tools/graph-adapter-common';

import type { PythonParsedFile, PythonParsedProject } from './parse.js';
import type {
  Catalog,
  CallEdge,
  DependencyEdge,
  DependencySiteRecord,
  EdgeSink,
  ResolutionStats,
  ResolveInput,
  ResolveOutput,
} from '@opensip-tools/graph';
import type { Node } from '@opensip-tools/tree-sitter';

function pythonPosition(
  node: Node,
  file: PythonParsedFile,
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

export function resolveCallSites(input: ResolveInput<PythonParsedProject>): ResolveOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges:python' });
  const byName = buildNameIndex(input.catalog.functions);
  const edgesByOwner = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink: EdgeSink = { edgesByOwner, stats };

  for (const r of input.callSites) {
    const node = r.nodeRef as Node;
    const file = r.sourceFileRef as PythonParsedFile;
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushCreationEdge(pythonPosition(node, file), r.ownerHash, r.childHash, sink);
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

  logger.info({
    evt: 'graph.edges.complete',
    module: 'graph:edges:python',
    ...finalStats,
  });

  // Phase 4 (DEC-498): resolve dependency sites if any. Mirrors the TS
  // adapter's resolveDependencies pattern adapted to Python's path-based
  // module discovery (no symbol table, no tsconfig resolution).
  const dependenciesByOwner =
    input.dependencySites && input.dependencySites.length > 0
      ? resolveDependencies(input.dependencySites, input.catalog)
      : undefined;

  return dependenciesByOwner === undefined
    ? { edgesByOwner, stats: finalStats }
    : { edgesByOwner, dependenciesByOwner, stats: finalStats };
}

/**
 * Resolve Python import sites to target module-init bodyHashes. Imports
 * resolving to an in-catalog `.py` (or `__init__.py`) source file map to
 * that file's module-init occurrence; imports resolving to standard-
 * library or third-party packages (outside the catalog) produce
 * unresolved `DependencyEdge` entries with `to: []` and the raw specifier
 * carried in `specifier` for downstream attribution.
 *
 * Python lacks a tsconfig-equivalent resolver, so this implements the
 * standard CPython search-path rules constrained to the project:
 *
 *   - Absolute dotted (`foo.bar`) → `foo/bar.py` or `foo/bar/__init__.py`
 *     relative to the project root.
 *   - Relative (`.foo`, `..pkg.sub`) → resolve relative to the importing
 *     file's directory, walking up one level per leading dot beyond the
 *     first (which means the current package).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498).
 */
function resolveDependencies(
  sites: readonly DependencySiteRecord[],
  catalog: Catalog,
): ReadonlyMap<string, readonly DependencyEdge[]> {
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
    const file = site.sourceFileRef as PythonParsedFile;
    const importerFilePath = pythonFilePathOf(file, catalog, site.ownerHash);
    const to = resolvePythonModuleSpecifier(site.specifier, importerFilePath, moduleInitByFilePath);
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
 * Recover the project-relative filePath of the importer from the catalog
 * (looking it up via the owner's module-init bodyHash). This avoids
 * threading the projectDirAbs / absolute path through dependency
 * resolution — the catalog already knows.
 */
function pythonFilePathOf(
  _file: PythonParsedFile,
  catalog: Catalog,
  ownerHash: string,
): string | null {
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
 * Resolve one Python import specifier to its target module-init
 * bodyHash(es). Returns `[]` when no project file matches (external
 * package, stdlib, or an unresolvable relative import that walks above
 * the project root).
 *
 * Handled shapes:
 *   - `foo`             → `foo.py` or `foo/__init__.py`
 *   - `foo.bar`         → `foo/bar.py` or `foo/bar/__init__.py`
 *   - `.sibling`        → same package → `sibling.py` / `sibling/__init__.py`
 *   - `..pkg.sub`       → up one package → `pkg/sub.py` / `pkg/sub/__init__.py`
 *
 * NOT handled:
 *   - PEP 420 namespace packages (we don't enumerate directories without
 *     an `__init__.py`).
 *   - `sys.path` extensions configured in `pyproject.toml` (`[tool.…]`
 *     `src` layouts where the package root isn't the project root).
 *     Files outside the project tree always resolve to external (`[]`).
 *   - `importlib.import_module(...)`, `__import__(...)`, conditional /
 *     nested imports inside function bodies (walker only emits top-level
 *     imports).
 */
function resolvePythonModuleSpecifier(
  specifier: string,
  importerFilePath: string | null,
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  const leadingDots = countLeadingDots(specifier);
  if (leadingDots === 0) {
    return resolveAbsoluteModule(specifier, moduleInitByFilePath);
  }
  if (importerFilePath === null) {
    /* v8 ignore next */
    return [];
  }
  return resolveRelativeModule(specifier, leadingDots, importerFilePath, moduleInitByFilePath);
}

function countLeadingDots(specifier: string): number {
  let n = 0;
  while (n < specifier.length && specifier[n] === '.') n++;
  return n;
}

function resolveAbsoluteModule(
  specifier: string,
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  return lookupModuleCandidates(specifier.split('.'), moduleInitByFilePath);
}

function resolveRelativeModule(
  specifier: string,
  leadingDots: number,
  importerFilePath: string,
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  // `from .x import y` — one dot → same package directory.
  // `from ..x import y` — two dots → parent package directory.
  // CPython: N dots = walk up (N - 1) directories from the importer's package.
  const importerDir = dirname(importerFilePath); // POSIX, project-relative
  let baseDir = importerDir;
  for (let i = 1; i < leadingDots; i++) {
    const parent = posix.dirname(baseDir);
    if (parent === baseDir) {
      // Walked above the project root → unresolvable.
      return [];
    }
    baseDir = parent;
  }
  const remainder = specifier.slice(leadingDots); // may be '' for `from . import x`
  const segments = remainder.length > 0 ? remainder.split('.') : [];
  // baseDir of '.' means project root; treat as empty prefix.
  const prefix = baseDir === '.' || baseDir === '' ? [] : baseDir.split('/');
  return lookupModuleCandidates([...prefix, ...segments], moduleInitByFilePath);
}

/**
 * Given dotted module segments (e.g. `['foo', 'bar']`), try the two
 * canonical file forms: `foo/bar.py` and `foo/bar/__init__.py`. Returns
 * the matching module-init bodyHash in a single-element array, or `[]`.
 */
function lookupModuleCandidates(
  segments: readonly string[],
  moduleInitByFilePath: ReadonlyMap<string, string>,
): readonly string[] {
  if (segments.length === 0) return [];
  const joined = segments.join('/');
  const candidates = [`${joined}.py`, `${joined}/__init__.py`];
  for (const candidate of candidates) {
    const hash = moduleInitByFilePath.get(candidate);
    if (hash !== undefined) return [hash];
  }
  return [];
}

function pushCallEdge(
  node: Node,
  file: PythonParsedFile,
  ownerHash: string,
  byName: ReadonlyMap<string, readonly string[]>,
  sink: EdgeSink,
): void {
  const { edgesByOwner, stats } = sink;
  stats.totalCallSites++;
  const target = extractCallTargetName(node);
  const pos = pythonPosition(node, file);
  const truncated = truncateForCallEdge(pos.text);
  const discarded = isReturnValueDiscarded(node);

  const edge: CallEdge = buildPythonCallEdge(target, byName, {
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

function buildPythonCallEdge(
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
 * Decode a `call` node's target into a simple name. Returns null when
 * we don't recognize the shape (subscript call, lambda call, etc.) —
 * those become unresolved edges.
 */
function extractCallTargetName(node: Node): string | null {
  // tree-sitter-python `call` has a `function` field for the callee.
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    return attr ? attr.text : null;
  }
  return null;
}

/**
 * The call's return value is discarded when the call expression is
 * the entire expression of an expression_statement. Mirrors
 * lang-typescript's logic for the `no-side-effect-path` rule.
 */
function isReturnValueDiscarded(node: Node): boolean {
  let parent: Node | null = node.parent;
  while (parent) {
    if (parent.type === 'parenthesized_expression' || parent.type === 'await') {
      parent = parent.parent;
      continue;
    }
    return parent.type === 'expression_statement';
  }
  return false;
}
