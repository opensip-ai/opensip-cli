/**
 * Stage 1+2 unified walk — Phase 4 of
 * docs/plans/graph-performance-improvements.md.
 *
 * Legacy pipeline walked every source file twice: once for Stage 1
 * (emit FunctionOccurrence records) and once for Stage 2 (locate +
 * resolve call sites). The two walks descend in identical order and
 * the only data flowing between them is each function-shape's
 * bodyHash — which Stage 1 already computes. Stage 2 was *re-hashing*
 * every function-shape to look it up in `fnByHash`.
 *
 * Phase 4 fuses both passes into one descent per file. The walker
 * emits both:
 *   - `occurrences` — what Stage 1 emitted (function/method/arrow/etc.
 *     records, plus a synthesized module-init per file).
 *   - `callSites` — flat list of nodes that Stage 2's resolvers care
 *     about, paired with the bodyHash that owns them. Resolution
 *     happens *outside* the walk, against this flat list.
 *
 * The orchestrator (`cli/orchestrate.ts`) drives the pipeline
 * end-to-end. `edges.ts` exposes `resolveEdgesFromRecords` as the
 * Stage 2 entry point, consuming the `callSites` this walk emits.
 */

import { relative, sep } from 'node:path';

import ts from 'typescript';

import { visitArrowFunction } from './inventory-visitors/arrow-function.js';
import { visitClassStaticBlock } from './inventory-visitors/class-static-init.js';
import { visitConstructorDeclaration } from './inventory-visitors/constructor-declaration.js';
import { visitFunctionDeclaration } from './inventory-visitors/function-declaration.js';
import { visitFunctionExpression } from './inventory-visitors/function-expression.js';
import { visitGetterSetter } from './inventory-visitors/getter-setter.js';
import { visitMethodDeclaration } from './inventory-visitors/method-declaration.js';
import { synthesizeModuleInit } from './inventory-visitors/module-init.js';
import { isTypescriptTestFile } from './test-file.js';

import type { VisitorContext } from './inventory-visitors/types.js';
import type { FunctionOccurrence, ParseError } from '@opensip-cli/graph';

/**
 * A node the unified walk identified as a candidate Stage 2 resolver
 * target — pre-paired with the bodyHash of its enclosing function-shape
 * occurrence so the resolver dispatcher doesn't need to re-walk the
 * AST or re-hash to find ownership.
 */
export interface CallSiteRecord {
  readonly node: ts.Node;
  readonly sourceFile: ts.SourceFile;
  /**
   * The function occurrence that owns this site, identified by its
   * `bodyHash`. Top-level (module-init) sites carry the synthesized
   * module-init occurrence's hash.
   */
  readonly ownerHash: string;
  /**
   * 'call' for resolver dispatch (call/new/jsx/identifier-ref/
   * shorthand). 'creation' for parent → nested-callable creation
   * edges (arrows, function-expressions, methods, accessors,
   * constructors); the resolver pass emits a static high-confidence
   * edge for these without consulting any resolver.
   */
  readonly kind: 'call' | 'creation';
  /**
   * For 'creation' kind, the bodyHash of the nested callable.
   */
  readonly childHash?: string;
}

/**
 * One module-level import site discovered by the walker. Resolved to
 * a target module-init bodyHash by the resolver (Phase 4 of opensip's
 * substrate consolidation — DEC-498).
 *
 * Covers `ImportDeclaration` and `ImportEqualsDeclaration` with a
 * string moduleSpecifier. Re-exports (`ExportDeclaration` with
 * `moduleSpecifier`) and dynamic imports (`import('…')` expressions)
 * are out of scope at v1 — they can be added in a follow-up if
 * dispatch grouping shows they matter.
 */
export interface DependencySiteRecord {
  readonly node: ts.Node;
  readonly sourceFile: ts.SourceFile;
  /** bodyHash of the file's synthesized module-init occurrence. */
  readonly ownerHash: string;
  /** Raw import specifier — `'./foo'`, `'@opensip/core'`, etc. */
  readonly specifier: string;
  /** 1-based line of the import statement. */
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
}

/**
 * One re-export the file declares, normalized to the data the engine's
 * export index needs to make a re-exported name resolvable under the
 * RE-EXPORTING package. Two TS forms produce these:
 *
 *   1. `export { a, b as c } from './y' | '@scope/pkg'` — an
 *      `ExportDeclaration` WITH a `moduleSpecifier`.
 *   2. `export { a, b }` (NO `from`) where `a`/`b` are bindings IMPORTED at
 *      the top of the file — TS's import-then-re-export idiom (e.g.
 *      `import { childrenOf } from '@opensip-cli/tree-sitter'; export
 *      { childrenOf }`). Correlated against the file's named imports.
 *
 * A plain `export { localDef }` of a name DEFINED in this file is NOT a
 * re-export — it is already an `'exported'` occurrence in the catalog — so it
 * produces no record.
 */
export interface ReExportRecord {
  /** Re-exporting file, project-relative POSIX (→ `packageOf` gives the group). */
  readonly fromFile: string;
  /** The name as exposed BY this module. `'*'` for `export * from`. */
  readonly exportedName: string;
  /** The name in the SOURCE module (== `exportedName` unless aliased via
   *  `export { x as y }`; `'*'` for star). */
  readonly sourceName: string;
  /** The source module specifier — relative (`'./x'`) or workspace (`'@scope/pkg'`). */
  readonly specifier: string;
}

export interface WalkInput {
  /**
   * The project's source files to walk. Supplied by the adapter from
   * either tier: exact mode passes `program.getSourceFiles()`; fast mode
   * passes the standalone source-file map's values. The walk is purely
   * structural — it needs `ts.SourceFile`s with parent pointers (which
   * both tiers provide) and nothing from the type checker — so it is
   * mode-agnostic and never sees a `ts.Program`.
   */
  readonly sourceFiles: Iterable<ts.SourceFile>;
  readonly files: readonly string[];
  readonly projectDirAbs: string;
}

export interface WalkOutput {
  readonly functions: Record<string, FunctionOccurrence[]>;
  readonly callSites: readonly CallSiteRecord[];
  readonly dependencySites: readonly DependencySiteRecord[];
  readonly reExports: readonly ReExportRecord[];
  readonly parseErrors: readonly ParseError[];
}

export function walkProgram(input: WalkInput): WalkOutput {
  const functions: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const callSites: CallSiteRecord[] = [];
  const dependencySites: DependencySiteRecord[] = [];
  const reExports: ReExportRecord[] = [];
  const parseErrors: ParseError[] = [];
  const filesSet = new Set(input.files.map(normalizeForCompare));

  for (const sf of input.sourceFiles) {
    if (sf.isDeclarationFile) continue;
    const sfPath = normalizeForCompare(sf.fileName);
    if (!filesSet.has(sfPath)) continue;
    try {
      walkFile(sf, input.projectDirAbs, functions, callSites, dependencySites);
      collectReExports(sf, input.projectDirAbs, reExports);
    } catch (error) {
      /* v8 ignore start */
      parseErrors.push({
        filePath: relative(input.projectDirAbs, sf.fileName),
        message: error instanceof Error ? error.message : String(error),
      });
      /* v8 ignore stop */
    }
  }

  return { functions, callSites, dependencySites, reExports, parseErrors };
}

/**
 * Walk a source file's top-level statements for `ImportDeclaration`
 * and `ImportEqualsDeclaration` nodes; emit one `DependencySiteRecord`
 * per import with a string module specifier. The owner is the file's
 * synthesized module-init occurrence (every file has exactly one).
 *
 * Phase 4 of opensip's substrate consolidation (DEC-498). Out of
 * scope at v1: re-exports (`ExportDeclaration` with `moduleSpecifier`),
 * dynamic imports (`import(…)` expressions), and side-effect imports
 * with no specifier identifier.
 */
function collectDependencySites(
  sourceFile: ts.SourceFile,
  moduleInitHash: string,
  out: DependencySiteRecord[],
): void {
  for (const stmt of sourceFile.statements) {
    let specifierNode: ts.Expression | undefined;
    if (ts.isImportDeclaration(stmt)) {
      specifierNode = stmt.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression !== undefined
    ) {
      specifierNode = stmt.moduleReference.expression;
    }
    if (specifierNode === undefined || !ts.isStringLiteral(specifierNode)) {
      continue;
    }
    const startPos = stmt.getStart(sourceFile);
    const lineChar = sourceFile.getLineAndCharacterOfPosition(startPos);
    out.push({
      node: stmt,
      sourceFile,
      ownerHash: moduleInitHash,
      specifier: specifierNode.text,
      line: lineChar.line + 1,
      column: lineChar.character,
    });
  }
}

/**
 * Collect the file's re-export declarations as {@link ReExportRecord}s. Two
 * forms (see the type doc): `export … from 'spec'` (a re-export with a module
 * specifier) and `export { x }` where `x` is an imported binding (correlated
 * against the file's named imports). A plain `export { localDef }` of a name
 * defined in this file is skipped — it is already an exported occurrence.
 */
function collectReExports(
  sourceFile: ts.SourceFile,
  projectDirAbs: string,
  out: ReExportRecord[],
): void {
  const fromFile = relative(projectDirAbs, sourceFile.fileName).split(sep).join('/');
  const imported = buildImportSourceMap(sourceFile);
  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) pushReExportsFromStmt(stmt, fromFile, imported, out);
  }
}

/** A named import's source: `binding → (specifier, the name in the source module)`.
 *  Drives the no-`from` re-export form (`export { childrenOf }`). */
interface ImportSource {
  readonly specifier: string;
  readonly importedName: string;
}

function buildImportSourceMap(sourceFile: ts.SourceFile): ReadonlyMap<string, ImportSource> {
  const imported = new Map<string, ImportSource>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const named = stmt.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      imported.set(el.name.text, {
        specifier: stmt.moduleSpecifier.text,
        importedName: (el.propertyName ?? el.name).text,
      });
    }
  }
  return imported;
}

/** Push the {@link ReExportRecord}s for one `ExportDeclaration` (both forms). */
function pushReExportsFromStmt(
  stmt: ts.ExportDeclaration,
  fromFile: string,
  imported: ReadonlyMap<string, ImportSource>,
  out: ReExportRecord[],
): void {
  const spec =
    stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : undefined;
  const clause = stmt.exportClause;

  // Form 1: `export … from 'spec'`.
  if (spec !== undefined) {
    if (clause === undefined) {
      // `export * from 'spec'` — re-exports every exported name of `spec`.
      out.push({ fromFile, exportedName: '*', sourceName: '*', specifier: spec });
    } else if (ts.isNamedExports(clause)) {
      for (const el of clause.elements) {
        out.push({
          fromFile,
          exportedName: el.name.text,
          sourceName: (el.propertyName ?? el.name).text,
          specifier: spec,
        });
      }
    }
    // NamespaceExport (`export * as ns from 'spec'`) — a namespace object, not a
    // directly-callable name; left to a follow-up.
    return;
  }

  // Form 2: `export { a, b as c }` with NO `from` — a re-export only when the
  // local binding was IMPORTED (otherwise it's a local definition's export).
  if (clause === undefined || !ts.isNamedExports(clause)) return;
  for (const el of clause.elements) {
    const imp = imported.get((el.propertyName ?? el.name).text);
    if (imp === undefined) continue; // local definition → already an occurrence
    out.push({
      fromFile,
      exportedName: el.name.text,
      sourceName: imp.importedName,
      specifier: imp.specifier,
    });
  }
}

function walkFile(
  sourceFile: ts.SourceFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
  callSites: CallSiteRecord[],
  dependencySites: DependencySiteRecord[],
): void {
  const filePathProjectRel = relative(projectDirAbs, sourceFile.fileName).split(sep).join('/');

  const baseCtx: VisitorContext = {
    sourceFile,
    projectDirAbs,
    filePathProjectRel,
    inTestFile: isTypescriptTestFile(filePathProjectRel),
    definedInGenerated: isGeneratedFile(filePathProjectRel),
    enclosingClass: null,
  };

  // One synthesized module-init per file. Its hash owns top-level
  // call sites discovered before any function-shape descent.
  const moduleInit = synthesizeModuleInit(sourceFile, baseCtx);
  record(out, moduleInit);

  // Phase 4 (DEC-498): walk top-level imports as dependency sites.
  collectDependencySites(sourceFile, moduleInit.bodyHash, dependencySites);

  function descend(node: ts.Node, ctx: VisitorContext, ownerHash: string): void {
    const occ = dispatchVisitor(node, ctx);
    let childOwnerHash = ownerHash;
    if (occ) {
      record(out, occ);
      childOwnerHash = occ.bodyHash;
      // Inline-callable creation edge from the parent owner. Function
      // declarations are deliberately excluded — they need a real
      // call edge to be reachable, which is what makes the orphan
      // rule catch genuinely unused top-level functions.
      if (isInlineCallable(node) && ownerHash !== childOwnerHash) {
        callSites.push({
          node,
          sourceFile,
          ownerHash,
          kind: 'creation',
          childHash: childOwnerHash,
        });
      }
    }

    if (isResolverCandidate(node)) {
      callSites.push({ node, sourceFile, ownerHash, kind: 'call' });
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      /* v8 ignore next */
      const className = node.name?.text ?? '<anon-class>';
      const childCtx: VisitorContext = { ...ctx, enclosingClass: className };
      // @graph-ignore-next-line graph:cycle -- intentional recursive descent; forEachChild re-enters the visitor (descend)
      ts.forEachChild(node, (c) => {
        descend(c, childCtx, childOwnerHash);
      });
      return;
    }

    ts.forEachChild(node, (c) => {
      descend(c, ctx, childOwnerHash);
    });
  }

  // SourceFile itself isn't function-shaped or a resolver candidate.
  // Descend its children directly with module-init as the initial
  // owner.
  ts.forEachChild(sourceFile, (c) => {
    descend(c, baseCtx, moduleInit.bodyHash);
  });
}

function record(out: Record<string, FunctionOccurrence[]>, occ: FunctionOccurrence): void {
  const list = out[occ.simpleName];
  if (list) {
    /* v8 ignore next */
    list.push(occ);
  } else {
    out[occ.simpleName] = [occ];
  }
}

/**
 * Visitor dispatch table — predicate-keyed pairs the walker iterates
 * to map a function-shaped node to its Stage 1 inventory visitor.
 * Adding a new function-shape (say, `import.meta` lazy modules) is a
 * one-line append here, not a new branch in `dispatchVisitor`.
 *
 * Order matters only when predicates overlap — they don't here, so
 * the table reads top-to-bottom in the same order the legacy
 * if-ladder did.
 *
 * Each entry is built via {@link visitorEntry}, which carries the
 * predicate's narrowed type into the visit callback. The cast
 * (`node as N`) is sound by construction — the dispatcher only
 * fires `visit` when `predicate(node)` returned true — but TS's
 * flow analysis can't see through a separate predicate/callback
 * pairing inside a literal, so the cast lives once inside the helper
 * rather than at every entry. Audit 2026-05-23 M-2.
 */
interface VisitorEntry {
  readonly predicate: (node: ts.Node) => boolean;
  readonly visit: (node: ts.Node, ctx: VisitorContext) => FunctionOccurrence | null;
}

function visitorEntry<N extends ts.Node>(
  predicate: (node: ts.Node) => node is N,
  visit: (node: N, ctx: VisitorContext) => FunctionOccurrence | null,
): VisitorEntry {
  return { predicate, visit: (n, c) => visit(n as N, c) };
}

const isAccessor = (n: ts.Node): n is ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
  ts.isGetAccessor(n) || ts.isSetAccessor(n);

const VISITOR_TABLE: readonly VisitorEntry[] = [
  visitorEntry(ts.isFunctionDeclaration, visitFunctionDeclaration),
  visitorEntry(ts.isArrowFunction, visitArrowFunction),
  visitorEntry(ts.isMethodDeclaration, visitMethodDeclaration),
  visitorEntry(ts.isConstructorDeclaration, visitConstructorDeclaration),
  visitorEntry(isAccessor, visitGetterSetter),
  visitorEntry(ts.isFunctionExpression, visitFunctionExpression),
  visitorEntry(ts.isClassStaticBlockDeclaration, visitClassStaticBlock),
];

/**
 * Dispatch a node to the right Stage 1 inventory visitor and return
 * the function occurrence (or null if the node isn't function-shaped).
 * Exported so external callers (and the public package barrel) can
 * share this dispatch table when they need to classify a single node
 * without driving the full walker.
 */
function dispatchVisitor(node: ts.Node, ctx: VisitorContext): FunctionOccurrence | null {
  for (const entry of VISITOR_TABLE) {
    if (entry.predicate(node)) return entry.visit(node, ctx);
  }
  return null;
}

/**
 * An inline callable (arrow / function-expression / method / accessor /
 * constructor) gets a creation edge from its enclosing scope so
 * reachability flows through inline callbacks even when the runtime
 * dispatch site is unresolvable. Function declarations are
 * deliberately excluded — they need a real call edge to be reachable.
 */
function isInlineCallable(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/**
 * Five resolver-target node shapes plus a fast pre-filter on bare
 * identifiers (most identifiers are declaration names or property
 * names, not value references). The filter mirrors the intent of
 * Stage 2's `isValueReference` — false positives just cost an extra
 * resolver call, false negatives lose edges, so err on admitting.
 */
function isResolverCandidate(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) return true;
  if (ts.isNewExpression(node)) return true;
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return true;
  if (ts.isShorthandPropertyAssignment(node)) return true;
  if (ts.isIdentifier(node)) return isLikelyValueReference(node);
  return false;
}

function isLikelyValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (isStructuralParent(parent)) return false;
  if (isJsxTagName(node, parent)) return false;
  if (isDeclarationName(node, parent)) return false;
  if (isPropertyOrLabelName(node, parent)) return false;
  if (isCallTargetIdentifier(node, parent)) return false;
  return true;
}

/**
 * The identifier IS the tag name of a JSX element (`<Banner/>`, `</Banner>`).
 * The JSX element node is its own resolver candidate
 * ({@link isResolverCandidate}) and `resolveJsxElement` owns the edge — so the
 * tag-name identifier must NOT also be admitted as a standalone value
 * reference, or the sharded boundary extractor recovers BOTH (element + tag
 * name) and emits a duplicate cross-package edge at the adjacent column. (Exact
 * silently drops the redundant value-ref; sharded did not — the source of the
 * 36 sharded-only column-twin divergences.) A qualified tag (`<A.B/>`) is a
 * PropertyAccess/QualifiedName and is already excluded by `isStructuralParent`.
 */
function isJsxTagName(node: ts.Identifier, parent: ts.Node): boolean {
  return (
    (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  );
}

/** Parents that make the identifier a type or import position. */
function isStructuralParent(parent: ts.Node): boolean {
  return (
    ts.isQualifiedName(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isTypeReferenceNode(parent)
  );
}

/** Identifier IS the declaration's name (binding position, not value). */
function isDeclarationName(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  return false;
}

/** Identifier is a property/label name (not a value reference). */
function isPropertyOrLabelName(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  return false;
}

/**
 * Identifier IS the call target — already collected as the enclosing
 * CallExpression / NewExpression, so skip the inner identifier to
 * avoid double-counting.
 */
function isCallTargetIdentifier(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  return false;
}

function normalizeForCompare(p: string): string {
  return p.split(sep).join('/');
}

function isGeneratedFile(rel: string): boolean {
  return /\bdist\/|\bbuild\/|\.generated\./.test(rel);
}
