/**
 * @fileoverview Function-scope AST helpers.
 *
 * Walking helpers that answer "what function am I inside?" / "is this in an
 * async context?" / "is this in a conditional branch?" — used by checks that
 * need to reason about scope boundaries (lifecycle cleanup, async waterfall
 * detection, etc.).
 *
 * Lives in its own module so consumers reading these helpers don't scroll
 * past unrelated parsing / inspection / comment-detection code, and so the
 * next round of scope helpers has a sensible home rather than landing in
 * the general-purpose `ast-utilities.ts` module.
 */

import * as ts from 'typescript';

// =============================================================================
// FUNCTION-LIKE PREDICATES
// =============================================================================

/**
 * Function-like nodes the helpers below treat as a "function boundary":
 * regular declarations, methods, function expressions, arrow functions, and
 * constructor declarations. The helpers stop their upward walk at any of
 * these.
 */
export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node)
  );
}

// =============================================================================
// ENCLOSING-FUNCTION WALKERS
// =============================================================================

/**
 * Walk up the AST from a node and return the nearest enclosing function-like
 * declaration. Includes constructors. Returns null when the node sits at
 * module scope.
 */
export function findEnclosingFunction(node: ts.Node): FunctionLikeNode | null {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Walk up the AST from a node and return the BODY of the nearest enclosing
 * function-like declaration when that body is a {@link ts.Block}. Returns
 * null when there is no enclosing function, or when the function uses an
 * expression body (e.g. an arrow function `() => x`) rather than a block.
 */
export function findEnclosingFunctionBody(node: ts.Node): ts.Block | null {
  const fn = findEnclosingFunction(node);
  if (!fn) return null;
  const body = fn.body;
  if (body && ts.isBlock(body)) return body;
  return null;
}

/**
 * Return the textual name of the nearest enclosing named function-like, or
 * null when the enclosing function is anonymous or there is no enclosing
 * function. Walks past anonymous arrow functions to the next named ancestor —
 * e.g. for a node inside `class Foo { bar() { (() => baz())() } }`, this
 * returns `'bar'`, not `null`.
 */
export function getEnclosingFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isMethodDeclaration(current)) {
      return current.name.getText(sourceFile);
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }
    // Named function expression: `const x = function namedFn() { … }`
    // — the name is part of the FunctionExpression, not its parent. Without
    // this branch the walker would skip past namedFn to its outer scope.
    if (ts.isFunctionExpression(current) && current.name) {
      return current.name.getText(sourceFile);
    }
    current = current.parent;
  }
  return null;
}

/**
 * Walk up the AST from a node and return the nearest function-like ancestor
 * OR the enclosing SourceFile. Differs from {@link findEnclosingFunction} in
 * that it always returns a node (never null) — the SourceFile acts as the
 * top-level scope.
 */
export function findEnclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
  return node.getSourceFile();
}

// =============================================================================
// ASYNC / CONDITIONAL CONTEXT
// =============================================================================

/**
 * Return true when `node` carries the `async` modifier. Uses the modern
 * `canHaveModifiers` + `getModifiers` API so it is safe to call on any node
 * kind, not just function-likes.
 */
export function isAsync(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

/**
 * Return true when `node` is nested inside an `async` function-like ancestor.
 * Walks up until the first function-like is found (returns false if none),
 * then asks {@link isAsync} of that function. Module-top-level code returns
 * false — there is no enclosing async context.
 */
export function isInAsyncContext(node: ts.Node): boolean {
  const fn = findEnclosingFunction(node);
  if (!fn) return false;
  return isAsync(fn);
}

/**
 * Return true when `node` is nested inside a conditional construct — `if`,
 * `else`, `switch` case, or a ternary expression — within its enclosing
 * function. Stops at function boundaries (does NOT cross into outer
 * functions).
 */
export function isInsideConditionalBlock(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionLike(current)) return false;
    if (ts.isIfStatement(current)) return true;
    if (ts.isSwitchStatement(current)) return true;
    if (ts.isCaseClause(current)) return true;
    if (ts.isConditionalExpression(current)) return true;
    current = current.parent;
  }
  return false;
}
