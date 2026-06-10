/**
 * Syntactic (checker-free) edge resolver — the fast-tier resolver.
 *
 * Resolves a call site from two signals only, never the type checker:
 *   1. the callee's simple name (`foo` in `foo()`, the rightmost name in
 *      `a.b.c()`, the tag in `<Foo/>`, etc.), extracted syntactically;
 *   2. the importing file's import graph — which module each name was
 *      imported from — used to disambiguate same-named functions across
 *      files.
 *
 * This generalizes the exact resolver's already-name-based
 * `resolveByCatalogFallback`: that seed resolves a unique name with no
 * file context; this adds import/same-file *pinning* to pick the right
 * occurrence when a name is ambiguous.
 *
 * Honest approximation (the core invariant in code): every verdict is
 * tagged `resolution: 'syntactic'` and confidence is CAPPED — `'medium'`
 * when the import graph (or a same-file definition) pinned the target
 * file, `'low'` otherwise. The fast path NEVER emits `'high'`; high
 * confidence is reserved for semantic resolution.
 */

import { relative, sep, posix } from 'node:path';

import ts from 'typescript';

import type { Catalog, FunctionOccurrence, ResolverVerdict } from '@opensip-tools/graph';

/**
 * Per-file import index: imported binding name → resolved target file
 * (project-relative POSIX path), or `null` when the import resolves
 * outside the catalog (external/bare package, unresolvable relative
 * path). Built once per source file by {@link buildImportIndex}.
 */
export type ImportIndex = ReadonlyMap<string, string | null>;

/** Context for a single syntactic resolution — all checker-free. */
export interface SyntacticContext {
  readonly catalog: Catalog;
  /** Project-relative POSIX path of the file containing the call site. */
  readonly currentFileRel: string;
  /** Import index for {@link currentFileRel}. */
  readonly importIndex: ImportIndex;
}

const UNRESOLVED: ResolverVerdict = { to: [], resolution: 'syntactic', confidence: 'low' };

/**
 * Collect the set of project-relative file paths the catalog knows about
 * (every occurrence carries one). Used to decide whether a resolved
 * import specifier lands inside the catalog.
 */
export function collectKnownFiles(catalog: Catalog): ReadonlySet<string> {
  const files = new Set<string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) files.add(o.filePath);
  }
  return files;
}

/**
 * Resolve a single walked call/new/jsx/value-reference node to a verdict
 * using only the callee name and the file's import graph.
 *
 * Returns `null` for a bare value reference / shorthand that resolves to
 * nothing (mirrors the exact resolver, which suppresses empty
 * value-reference verdicts rather than emitting a useless edge). A real
 * call/new/jsx site that doesn't resolve still returns a verdict (with
 * `to: []`) so it is counted as an unresolved call site.
 */
export function resolveSyntactic(node: ts.Node, ctx: SyntacticContext): ResolverVerdict | null {
  const callee = calleeSimpleName(node);
  if (callee === null) return null;

  const candidates = ctx.catalog.functions[callee.name];
  const isCallish = callee.shape === 'call';

  if (!candidates || candidates.length === 0) {
    // No catalog occurrence by this name. Bare references suppress;
    // real call sites count as unresolved.
    return isCallish ? UNRESOLVED : null;
  }

  const pin = resolvePin(callee.name, ctx, candidates);
  const verdict = verdictForPin(pin, candidates);

  // Suppress an empty bare-reference verdict (parity with exact mode).
  if (verdict.to.length === 0 && !isCallish) return null;
  return verdict;
}

// ── pin resolution ────────────────────────────────────────────────

type Pin =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'none' };

/**
 * Decide which file (if any) the call's target is pinned to:
 *   - imported name → the module it was imported from (or `external`
 *     when that module is outside the catalog);
 *   - not imported but a same-named occurrence lives in this file →
 *     pin to this file (a same-file definition is as reliable a
 *     syntactic signal as an import);
 *   - otherwise → no pin (fall back to a project-wide name lookup).
 */
function resolvePin(
  name: string,
  ctx: SyntacticContext,
  candidates: readonly FunctionOccurrence[],
): Pin {
  if (ctx.importIndex.has(name)) {
    const target = ctx.importIndex.get(name) ?? null;
    return target === null ? { kind: 'external' } : { kind: 'file', file: target };
  }
  if (candidates.some((c) => c.filePath === ctx.currentFileRel)) {
    return { kind: 'file', file: ctx.currentFileRel };
  }
  return { kind: 'none' };
}

function verdictForPin(pin: Pin, candidates: readonly FunctionOccurrence[]): ResolverVerdict {
  if (pin.kind === 'file') {
    const matches = candidates.filter((c) => c.filePath === pin.file);
    if (matches.length > 0) {
      // Import/same-file pinned — the strongest syntactic signal. Cap at
      // medium. Multiple matches (overloads in one file) all flow through.
      return {
        to: matches.map((m) => m.bodyHash),
        resolution: 'syntactic',
        confidence: 'medium',
      };
    }
    // Imported from a catalog file that has no such occurrence
    // (e.g. a re-export) — degrade to a name-only guess.
    return nameOnlyVerdict(candidates);
  }
  if (pin.kind === 'external') {
    // Imported from outside the catalog: the real target is external, so
    // a same-named project function would be a wrong guess. Stay honest.
    return UNRESOLVED;
  }
  return nameOnlyVerdict(candidates);
}

/**
 * No file pin: resolve by name alone. A unique candidate is a low-
 * confidence guess; multiple candidates are genuinely ambiguous without
 * type info, so we decline (empty `to`) rather than emit noise — the same
 * conservative call the exact `resolveByCatalogFallback` makes.
 */
function nameOnlyVerdict(candidates: readonly FunctionOccurrence[]): ResolverVerdict {
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only) return { to: [only.bodyHash], resolution: 'syntactic', confidence: 'low' };
  }
  return UNRESOLVED;
}

// ── syntactic callee-name extraction ──────────────────────────────

export interface Callee {
  readonly name: string;
  /** 'call' = call/new/jsx (a real invocation); 'ref' = bare value reference. */
  readonly shape: 'call' | 'ref';
}

/**
 * Extract the callee's simple name from a walked resolver-candidate node,
 * purely syntactically. Returns `null` when no simple name is available
 * (e.g. an element-access call `a[b]()` or a computed tag).
 *
 * Exported so the cross-shard boundary extractor can identify a call
 * site's callee name without re-implementing the per-node-kind logic.
 */
export function calleeSimpleName(node: ts.Node): Callee | null {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const name = expressionSimpleName(node.expression);
    return name === null ? null : { name, shape: 'call' };
  }
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const name = jsxTagSimpleName(node.tagName);
    return name === null ? null : { name, shape: 'call' };
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return { name: node.name.text, shape: 'ref' };
  }
  if (ts.isIdentifier(node)) {
    return { name: node.text, shape: 'ref' };
  }
  return null;
}

/** Rightmost simple name of a call/new target expression. */
function expressionSimpleName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** Rightmost simple name of a JSX tag (`Foo` or `A.B.Foo`). */
function jsxTagSimpleName(tag: ts.JsxTagNameExpression): string | null {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return tag.name.text;
  return null;
}

// ── import-index construction ─────────────────────────────────────

/**
 * Build the per-file import index by reading the file's `import` /
 * `import =` statements and resolving each specifier to a project file
 * (or `null` when it resolves outside the catalog). No type checker, no
 * `ts.Program` — relative specifiers are resolved against the known-file
 * set syntactically; bare specifiers are treated as external.
 */
export function buildImportIndex(
  sourceFile: ts.SourceFile,
  projectDirAbs: string,
  knownFilesRel: ReadonlySet<string>,
): ImportIndex {
  const currentFileRel = toProjectRel(projectDirAbs, sourceFile.fileName);
  const index = new Map<string, string | null>();

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const target = resolveSpecifierToFile(
        stmt.moduleSpecifier.text,
        currentFileRel,
        knownFilesRel,
      );
      indexImportClause(stmt.importClause, target, index);
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression !== undefined &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      const target = resolveSpecifierToFile(
        stmt.moduleReference.expression.text,
        currentFileRel,
        knownFilesRel,
      );
      index.set(stmt.name.text, target);
    }
  }
  return index;
}

/** Record every binding name an import clause introduces → `value`. */
function indexImportClause<V>(
  clause: ts.ImportClause | undefined,
  value: V,
  index: Map<string, V>,
): void {
  if (clause === undefined) return;
  // `import Foo from '…'`
  if (clause.name !== undefined) index.set(clause.name.text, value);
  const bindings = clause.namedBindings;
  if (bindings === undefined) return;
  if (ts.isNamespaceImport(bindings)) {
    // `import * as ns from '…'`
    index.set(bindings.name.text, value);
  } else {
    // `import { a, b as c } from '…'`
    for (const el of bindings.elements) index.set(el.name.text, value);
  }
}

/**
 * Build a per-file index of imported binding name → the RAW import
 * specifier it came from (`'./x.js'`, `'@scope/pkg'`). Distinct from
 * {@link buildImportIndex} (which resolves to a project file): the
 * cross-shard boundary pass needs the raw specifier to re-resolve against
 * the GLOBAL catalog, where the target file may live in another shard not
 * present in this file's known-file set.
 */
export function buildImportSpecifierIndex(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      indexImportClause(stmt.importClause, stmt.moduleSpecifier.text, index);
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression !== undefined &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      index.set(stmt.name.text, stmt.moduleReference.expression.text);
    }
  }
  return index;
}

/**
 * Resolve a relative import specifier to a known project file. Bare
 * specifiers (`@scope/pkg`, `node:fs`) resolve to `null` (external).
 * Relative specifiers are joined against the importing file's directory
 * and matched against the catalog's known files, trying the standard TS
 * extension and index-file candidates — no filesystem access, no tsc.
 */
function resolveSpecifierToFile(
  specifier: string,
  currentFileRel: string,
  knownFilesRel: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null; // bare/external
  const baseDir = posix.dirname(currentFileRel);
  const joined = posix.normalize(posix.join(baseDir, specifier));
  const stripped = joined.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, '');
  const candidates = [
    joined,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mts`,
    `${stripped}.cts`,
    `${stripped}/index.ts`,
    `${stripped}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (knownFilesRel.has(candidate)) return candidate;
  }
  return null;
}

/** Absolute file path → project-relative POSIX path (catalog filePath shape). */
function toProjectRel(projectDirAbs: string, fileNameAbs: string): string {
  return relative(projectDirAbs, fileNameAbs).split(sep).join('/');
}
