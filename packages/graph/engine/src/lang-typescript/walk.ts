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
 * The orchestrator (`cli/orchestrate.ts`) still drives the pipeline
 * end-to-end. `inventory.ts` and `edges.ts` retain their public
 * single-stage entry points for tests/external callers; their bodies
 * delegate to this module.
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

import type { FunctionOccurrence, ParseError } from '../types.js';
import type { VisitorContext } from './inventory-visitors/types.js';

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

export interface WalkInput {
  readonly program: ts.Program;
  readonly files: readonly string[];
  readonly projectDirAbs: string;
}

export interface WalkOutput {
  readonly functions: Record<string, FunctionOccurrence[]>;
  readonly callSites: readonly CallSiteRecord[];
  readonly parseErrors: readonly ParseError[];
}

export function walkProgram(input: WalkInput): WalkOutput {
  const functions: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const callSites: CallSiteRecord[] = [];
  const parseErrors: ParseError[] = [];
  const filesSet = new Set(input.files.map(normalizeForCompare));

  for (const sf of input.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const sfPath = normalizeForCompare(sf.fileName);
    if (!filesSet.has(sfPath)) continue;
    try {
      walkFile(sf, input.projectDirAbs, functions, callSites);
    } catch (error) {
      /* v8 ignore start */
      parseErrors.push({
        filePath: relative(input.projectDirAbs, sf.fileName),
        message: error instanceof Error ? error.message : String(error),
      });
      /* v8 ignore stop */
    }
  }

  return { functions, callSites, parseErrors };
}

function walkFile(
  sourceFile: ts.SourceFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
  callSites: CallSiteRecord[],
): void {
  const filePathProjectRel = relative(projectDirAbs, sourceFile.fileName)
    .split(sep)
    .join('/');

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
      ts.forEachChild(node, (c) => { descend(c, childCtx, childOwnerHash); });
      return;
    }

    ts.forEachChild(node, (c) => { descend(c, ctx, childOwnerHash); });
  }

  // SourceFile itself isn't function-shaped or a resolver candidate.
  // Descend its children directly with module-init as the initial
  // owner.
  ts.forEachChild(sourceFile, (c) => { descend(c, baseCtx, moduleInit.bodyHash); });
}

function record(
  out: Record<string, FunctionOccurrence[]>,
  occ: FunctionOccurrence,
): void {
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
export function dispatchVisitor(node: ts.Node, ctx: VisitorContext): FunctionOccurrence | null {
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
export function isInlineCallable(node: ts.Node): boolean {
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
  if (isDeclarationName(node, parent)) return false;
  if (isPropertyOrLabelName(node, parent)) return false;
  if (isCallTargetIdentifier(node, parent)) return false;
  return true;
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
