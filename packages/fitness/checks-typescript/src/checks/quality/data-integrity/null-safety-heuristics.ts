/**
 * @fileoverview Null-safety AST heuristics for convention-based detection.
 */

import * as ts from 'typescript';

import { SAFE_FLUENT_METHODS, SAFE_METHOD_PREFIXES } from './null-safety-config.js';

/**
 * Check if a call expression is a known safe builder pattern.
 *
 * Two paths:
 *  1. Explicit allowlist (`SAFE_BUILDER_PREFIXES`) — exact-prefix match on the
 *     full call text (e.g. `z.string(`, `pathToFileURL(`).
 *  2. Convention heuristic — when the callee is a bare identifier whose name
 *     starts with a recognised safe verb (`get*`, `read*`, `resolve*`,
 *     `current*`, `create*`, `build*`, etc.). This is the same convention that
 *     already covers fluent-chain methods via `isSafeFluentMethod`; applying it
 *     to standalone calls closes the gap for helpers like `resolveProjectPaths`,
 *     `readScope`, `currentScenarioRegistry`, etc. whose names convey the same
 *     "returns a value or throws" contract.
 */
export function isSafeBuilderPattern(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  safeBuilders: readonly string[],
): boolean {
  const text = expression.getText(sourceFile);
  if (safeBuilders.some((prefix) => text.startsWith(prefix))) return true;
  if (ts.isIdentifier(expression.expression)) {
    const name = expression.expression.text;
    if (isSafeFluentMethod(name)) return true;
    // Local `repoFor()`-style factories return a fresh non-null handle.
    if (name.endsWith('For')) return true;
    return false;
  }
  if (ts.isPropertyAccessExpression(expression.expression)) {
    return isSafeFluentMethod(expression.expression.name.text);
  }
  return false;
}

/**
 * Check if a method name is a known safe fluent API method.
 * Matches either an exact entry in SAFE_FLUENT_METHODS or a method whose name
 * starts with a common safe prefix (get, set, is, has, to, etc.).
 */
export function isSafeFluentMethod(methodName: string): boolean {
  if (SAFE_FLUENT_METHODS.has(methodName)) return true;
  return SAFE_METHOD_PREFIXES.some((prefix) => methodName.startsWith(prefix));
}

/**
 * Walk ancestors to find an enclosing truthiness guard whose condition
 * references the access's base expression — an `if (...)`, a `cond ? … : …`,
 * or the left side of a `&&` chain (e.g. `if (candidates.length === 1 &&
 * candidates[0]) { … candidates[0].bodyHash … }`).
 *
 * The line-local {@link SAFE_PATTERNS} scan only inspects the physical line
 * of the access, so a guard placed on a *previous* line is missed. This
 * closes that cross-line gap. Substring matching is intentionally lenient:
 * the check errs toward treating a guarded access as safe (fewer false
 * positives), consistent with the existing line-local guard handling.
 */
export function isGuardedByEnclosingCondition(
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const baseText = node.expression.getText(sourceFile);
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isIfStatement(parent) && parent.expression.getText(sourceFile).includes(baseText)) {
      return true;
    }
    if (
      ts.isConditionalExpression(parent) &&
      parent.condition.getText(sourceFile).includes(baseText)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === current &&
      parent.left.getText(sourceFile).includes(baseText)
    ) {
      return true;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Check if a property access originates from `this`.
 * Accessing properties on `this` is always safe — the object exists within its own methods.
 */
export function isThisAccess(node: ts.PropertyAccessExpression): boolean {
  let current: ts.Expression = node.expression;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return current.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * Count the depth of a method chain (number of chained property accesses / calls).
 * e.g. `a.b().c().d` has depth 3.
 */
export function getChainDepth(node: ts.PropertyAccessExpression): number {
  let depth = 0;
  let current: ts.Expression = node.expression;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    if (ts.isCallExpression(current)) {
      depth++;
      current = current.expression;
    } else {
      current = current.expression;
    }
  }
  return depth;
}

const SCHEMA_BUILDER_METHODS = new Set([
  'strict',
  'optional',
  'safeParse',
  'parse',
  'pipe',
  'superRefine',
  'catchall',
  'passthrough',
  'refine',
  'default',
  'transform',
]);

function calleeRootEndsWithSchema(expr: ts.Expression, sourceFile: ts.SourceFile): boolean {
  let current: ts.Expression = expr;
  while (current) {
    if (ts.isIdentifier(current)) {
      return current.text.endsWith('Schema') || current.text === 'z';
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (current.expression.getText(sourceFile) === 'z') return true;
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Zod and project schema-builder chains (including `FooSchema.strict().safeParse`).
 */
export function isSchemaBuilderChain(
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
): boolean {
  if (isZodBuilderChain(node, sourceFile)) return true;

  let current: ts.Expression = node.expression;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee) && SCHEMA_BUILDER_METHODS.has(callee.name.text)) {
        if (calleeRootEndsWithSchema(callee.expression, sourceFile)) return true;
      }
      if (ts.isIdentifier(callee)) {
        if (callee.text.endsWith('Schema') || callee.text.endsWith('Namespace')) return true;
      }
      current = callee;
      if (ts.isPropertyAccessExpression(current)) current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      return current.text.endsWith('Schema');
    }
    break;
  }
  return false;
}

function isFunctionParameter(name: string, fn: ts.SignatureDeclaration): boolean {
  return fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

/**
 * True when accessing `arr[i].prop` where `i` is a parameter of the enclosing
 * callback (e.g. chunked POST `timeoutFor: (_chunk, i) => chunks[i].signals`).
 */
export function isCallbackIndexGuarded(
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const receiver = node.expression;
  if (!ts.isElementAccessExpression(receiver)) return false;
  const index = receiver.argumentExpression;
  if (!index || !ts.isIdentifier(index)) return false;
  const indexName = index.text;

  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (isFunctionParameter(indexName, current)) return true;
    }
    if (ts.isFunctionDeclaration(current)) {
      if (isFunctionParameter(indexName, current)) return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Check if a property access chain is on a Zod method call
 * Handles chained calls like z.string().min(1).optional()
 */
export function isZodBuilderChain(
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
): boolean {
  // Walk the full expression chain to find if it originates from z.xxx()
  // Handles arbitrary depth: z.string().regex().optional().superRefine().pipe()
  let current: ts.Expression = node.expression;

  while (current) {
    if (ts.isCallExpression(current)) {
      const result = checkZodCallExpression(current, sourceFile);
      if (result.resolved) return result.isZod;
      current = result.next;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (current.expression.getText(sourceFile) === 'z') return true;
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      return current.text === 'z';
    }
    break;
  }
  return false;
}

/** Check if a call expression callee originates from z.xxx() */
export function checkZodCallExpression(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { resolved: true; isZod: boolean } | { resolved: false; next: ts.Expression } {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.getText(sourceFile).startsWith('z.')) return { resolved: true, isZod: true };
    return { resolved: false, next: callee.expression };
  }
  if (ts.isIdentifier(callee)) {
    return { resolved: true, isZod: callee.text === 'z' };
  }
  return { resolved: false, next: callee };
}

/**
 * Check if a property access is part of a fluent API chain
 * Handles patterns like promise.then().catch() or queryBuilder.where().orderBy()
 */
export function isFluentChain(node: ts.PropertyAccessExpression): boolean {
  const expression = node.expression;

  // Check if we're accessing a property on a call expression
  if (!ts.isCallExpression(expression)) return false;

  // Walk the chain — if ANY method in the chain is a known fluent method, the chain is safe
  let current: ts.Expression = expression;

  while (ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const methodName = current.expression.name.text;
      if (isSafeFluentMethod(methodName)) {
        return true;
      }
      // Walk deeper into the chain
      current = current.expression.expression;
      continue;
    }
    break;
  }

  return false;
}
