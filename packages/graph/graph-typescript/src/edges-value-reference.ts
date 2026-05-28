/**
 * @fileoverview Value-reference and shorthand-assignment resolution.
 *
 * Extracted from `edges.ts` so the main edge-resolution module stays
 * focused on the orchestrator + dispatch table. This file owns:
 *
 *  - The AST predicates that classify an Identifier as a *value*
 *    reference (i.e. not a declaration name, not a structural slot,
 *    not the target of a call/new/JSX).
 *  - The symbol-to-bodyHash resolution shared by both the
 *    `Identifier`-as-value-reference and `ShorthandPropertyAssignment`
 *    resolvers.
 */

import ts from 'typescript';

import { findCatalogEntry } from './edge-helpers/find-catalog-entry.js';

import type { ResolverContext } from './edge-resolvers/types.js';
import type { ResolverVerdict } from '@opensip-tools/graph';

/**
 * Identifier appears in a value position — not as a call target, not as
 * a binding name, not as the property name of a property access. We
 * want to capture handoff cases: function passed as argument, shorthand
 * property assignment, default value, return value.
 */
export function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return !isStructuralName(node, parent) && !isCallSiteTarget(node, parent);
}

/**
 * Identifier is the *name* of some declaration / property, or part of
 * a type / import / export. Not a value use.
 */
function isStructuralName(node: ts.Identifier, parent: ts.Node): boolean {
  return isParentNamePosition(node, parent) || isUnconditionallyStructural(parent);
}

function isParentNamePosition(node: ts.Identifier, parent: ts.Node): boolean {
  // Each entry: matcher for the parent kind + the property whose value
  // we compare with `node` to decide whether the identifier is the
  // structural name slot.
  const slot = readNamedSlot(parent);
  return slot === node;
}

function readNamedSlot(parent: ts.Node): ts.Node | undefined {
  if (ts.isVariableDeclaration(parent)) return parent.name;
  if (ts.isParameter(parent)) return parent.name;
  if (ts.isFunctionDeclaration(parent)) return parent.name;
  if (ts.isClassDeclaration(parent)) return parent.name;
  if (ts.isMethodDeclaration(parent)) return parent.name;
  if (ts.isPropertyDeclaration(parent)) return parent.name;
  if (ts.isPropertyAssignment(parent)) return parent.name;
  if (ts.isPropertyAccessExpression(parent)) return parent.name;
  if (ts.isLabeledStatement(parent)) return parent.label;
  if (ts.isBindingElement(parent)) return parent.name;
  return undefined;
}

function isUnconditionallyStructural(parent: ts.Node): boolean {
  return (
    ts.isQualifiedName(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isTypeReferenceNode(parent)
  );
}

/** Identifier is the call target / new target / JSX tag — we handle those elsewhere. */
function isCallSiteTarget(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  if (ts.isJsxOpeningElement(parent) && parent.tagName === node) return true;
  if (ts.isJsxSelfClosingElement(parent) && parent.tagName === node) return true;
  return false;
}

export function resolveValueReference(
  node: ts.Identifier,
  ctx: ResolverContext,
): ResolverVerdict {
  const symbol = ctx.typeChecker.getSymbolAtLocation(node);
  return resolveSymbolToHash(symbol, node.text, ctx);
}

export function resolveShorthandAssignment(
  node: ts.ShorthandPropertyAssignment,
  ctx: ResolverContext,
): ResolverVerdict {
  const symbol = ctx.typeChecker.getShorthandAssignmentValueSymbol(node);
  return resolveSymbolToHash(symbol, node.name.text, ctx);
}

/**
 * Resolve any symbol whose declarations might be a function-shaped
 * node to its catalog bodyHash. Used by value-reference and shorthand
 * resolvers — they share this lookup logic.
 */
function resolveSymbolToHash(
  symbol: ts.Symbol | undefined,
  fallbackName: string,
  ctx: ResolverContext,
): ResolverVerdict {
  if (!symbol) return { to: [], resolution: 'unknown', confidence: 'low' };
  for (const d of symbol.getDeclarations() ?? []) {
    const hash = hashFromDeclaration(d, fallbackName, ctx);
    if (hash) return { to: [hash], resolution: 'static', confidence: 'medium' };
  }
  return { to: [], resolution: 'unknown', confidence: 'low' };
}

function hashFromDeclaration(
  d: ts.Declaration,
  fallbackName: string,
  ctx: ResolverContext,
): string | null {
  if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
    const ctor = findClassConstructor(d);
    if (!ctor) return null;
    const className = d.name?.text;
    return findCatalogEntry(ctor, d.getSourceFile(), ctx.catalog, className ? [className] : []);
  }
  if (
    ts.isFunctionDeclaration(d) ||
    ts.isArrowFunction(d) ||
    ts.isFunctionExpression(d) ||
    ts.isMethodDeclaration(d)
  ) {
    return findCatalogEntry(d, d.getSourceFile(), ctx.catalog, [fallbackName]);
  }
  if (ts.isVariableDeclaration(d) && d.initializer) {
    const init = d.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return findCatalogEntry(init, d.getSourceFile(), ctx.catalog, [fallbackName]);
    }
  }
  return null;
}

/* v8 ignore start */
function findClassConstructor(cls: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | null {
  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m)) return m;
  }
  return null;
}
/* v8 ignore stop */
