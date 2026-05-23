// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Shared AST utilities for fitness checks.
 *
 * Common TypeScript AST operations for source parsing, tree walking,
 * and node inspection. Used by AST-based fitness checks. Lives in
 * @opensip-tools/lang-typescript so the dependency on `typescript` is
 * isolated to the language pack.
 */

import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'
import * as ts from 'typescript'


import { typescriptAdapter } from './adapter.js'

// =============================================================================
// SOURCE PARSING
// =============================================================================

/**
 * Parse TypeScript/JavaScript source into an AST SourceFile.
 * Returns null on parse failure.
 */
export function parseSource(content: string, filePath: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  } catch {
    return null
  }
}

/**
 * Cached parse — uses the language-aware parse cache via the registered
 * TS adapter. Falls back to a direct parse when no cache is active.
 */
export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
  return getParseTree(typescriptAdapter, filePath, content)
}

// =============================================================================
// TREE WALKING
// =============================================================================

/**
 * Depth-first walk of all nodes in a SourceFile or subtree.
 */
export function walkNodes(root: ts.Node, visitor: (node: ts.Node) => void): void {
  function visit(node: ts.Node): void {
    visitor(node)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(root, visit)
}

// =============================================================================
// NODE INSPECTION
// =============================================================================

/**
 * Get the leaf identifier text from an expression node.
 */
export function getIdentifierName(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return ''
}

/**
 * Get the full dotted path of a property access chain.
 */
export function getPropertyChain(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    return `${getPropertyChain(node.expression)}.${node.name.text}`
  }
  return ''
}

/**
 * Get the 1-indexed line number for a node.
 */
export function getLineNumber(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  return line + 1
}

/**
 * Get the column number (0-indexed) for a node.
 */
export function getColumn(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  return character
}

/**
 * Check if a node is a property access matching a specific property name.
 */
export function isPropertyAccess(node: ts.Node, propertyName: string): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === propertyName
}

/**
 * Check if a node is a literal value.
 */
export function isLiteral(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return true
  if (ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
    return true
  if (node.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isIdentifier(node) && node.text === 'undefined') return true
  return false
}

/**
 * Check if a node is inside a string literal or template literal.
 */
export function isInStringLiteral(node: ts.Node): boolean {
  let current = node.parent
  while (!ts.isSourceFile(current)) {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isTemplateExpression(current)
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

// =============================================================================
// NODE FINDERS
// =============================================================================

/**
 * Find all call expressions matching `object.method()` pattern.
 */
export function findCallExpressions(
  root: ts.Node,
  objectName: string,
  methodName: string,
): ts.CallExpression[] {
  const results: ts.CallExpression[] = []
  walkNodes(root, (node) => {
    if (!ts.isCallExpression(node)) return
    const expr = node.expression
    if (!ts.isPropertyAccessExpression(expr)) return
    if (expr.name.text !== methodName) return
    const chain = getPropertyChain(expr.expression)
    if (chain === objectName || chain.endsWith(`.${objectName}`)) {
      results.push(node)
    }
  })
  return results
}

/**
 * Find all binary expressions with a specific operator.
 */
export function findBinaryExpressions(
  root: ts.Node,
  operator: ts.SyntaxKind,
): ts.BinaryExpression[] {
  const results: ts.BinaryExpression[] = []
  walkNodes(root, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === operator) {
      results.push(node)
    }
  })
  return results
}

/**
 * Find all template literal expressions (with substitutions).
 */
export function findTemplateLiterals(root: ts.Node): ts.TemplateExpression[] {
  const results: ts.TemplateExpression[] = []
  walkNodes(root, (node) => {
    if (ts.isTemplateExpression(node)) {
      results.push(node)
    }
  })
  return results
}

// =============================================================================
// COMMENT DETECTION
// =============================================================================

function isPositionInRanges(position: number, ranges: ts.CommentRange[] | undefined): boolean {
  if (!ranges) return false
  for (const range of ranges) {
    if (position >= range.pos && position < range.end) return true
  }
  return false
}

/**
 * Check if a position in the source falls inside a comment.
 */
export function isInComment(position: number, sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.getFullText()
  const lineStarts = sourceFile.getLineStarts()

  for (let i = 0; i < lineStarts.length; i++) {
    const lineStart = lineStarts[i] ?? 0
    const lineEnd = i + 1 < lineStarts.length ? (lineStarts[i + 1] ?? text.length) : text.length

    if (position < lineStart || position >= lineEnd) continue

    if (isPositionInRanges(position, ts.getLeadingCommentRanges(text, lineStart))) return true
    if (isPositionInRanges(position, ts.getTrailingCommentRanges(text, lineStart))) return true
  }

  return false
}

// =============================================================================
// STRING UTILITIES
// =============================================================================

/**
 * Count unescaped backtick characters in a line.
 */
export function countUnescapedBackticks(line: string): number {
  let count = 0
  for (let ci = 0; ci < line.length; ci++) {
    if (line[ci] === '`' && (ci === 0 || line[ci - 1] !== '\\')) count++
  }
  return count
}

// =============================================================================
// FUNCTION-SCOPE HELPERS
// =============================================================================

/**
 * Function-like nodes the helpers below treat as a "function boundary":
 * regular declarations, methods, function expressions, arrow functions, and
 * constructor declarations. The helpers stop their upward walk at any of
 * these.
 */
type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.ConstructorDeclaration

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node)
  )
}

/**
 * Walk up the AST from a node and return the nearest enclosing function-like
 * declaration. Includes constructors. Returns null when the node sits at
 * module scope.
 */
export function findEnclosingFunction(node: ts.Node): FunctionLikeNode | null {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionLike(current)) return current
    current = current.parent
  }
  return null
}

/**
 * Walk up the AST from a node and return the BODY of the nearest enclosing
 * function-like declaration when that body is a {@link ts.Block}. Returns
 * null when there is no enclosing function, or when the function uses an
 * expression body (e.g. an arrow function `() => x`) rather than a block.
 */
export function findEnclosingFunctionBody(node: ts.Node): ts.Block | null {
  const fn = findEnclosingFunction(node)
  if (!fn) return null
  const body = fn.body
  if (body && ts.isBlock(body)) return body
  return null
}

/**
 * Return the textual name of the nearest enclosing named function-like, or
 * null when the enclosing function is anonymous or there is no enclosing
 * function. Walks past anonymous arrow functions to the next named ancestor —
 * e.g. for a node inside `class Foo { bar() { (() => baz())() } }`, this
 * returns `'bar'`, not `null`.
 */
export function getEnclosingFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isMethodDeclaration(current)) {
      return current.name.getText(sourceFile)
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.getText(sourceFile)
    }
    current = current.parent
  }
  return null
}

/**
 * Walk up the AST from a node and return the nearest function-like ancestor
 * OR the enclosing SourceFile. Differs from {@link findEnclosingFunction} in
 * that it always returns a node (never null) — the SourceFile acts as the
 * top-level scope.
 */
export function findEnclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isFunctionLike(current) || ts.isSourceFile(current)) return current
    current = current.parent
  }
  return node.getSourceFile()
}

/**
 * Return true when `node` carries the `async` modifier. Uses the modern
 * `canHaveModifiers` + `getModifiers` API so it is safe to call on any node
 * kind, not just function-likes.
 */
export function isAsync(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false
}

/**
 * Return true when `node` is nested inside an `async` function-like ancestor.
 * Walks up until the first function-like is found (returns false if none),
 * then asks {@link isAsync} of that function. Module-top-level code returns
 * false — there is no enclosing async context.
 */
export function isInAsyncContext(node: ts.Node): boolean {
  const fn = findEnclosingFunction(node)
  if (!fn) return false
  return isAsync(fn)
}

/**
 * Return true when `node` is nested inside a conditional construct — `if`,
 * `else`, `switch` case, or a ternary expression — within its enclosing
 * function. Stops at function boundaries (does NOT cross into outer
 * functions).
 */
export function isInsideConditionalBlock(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionLike(current)) return false
    if (ts.isIfStatement(current)) return true
    if (ts.isSwitchStatement(current)) return true
    if (ts.isCaseClause(current)) return true
    if (ts.isConditionalExpression(current)) return true
    current = current.parent
  }
  return false
}

/** Re-export TypeScript namespace for check authors */
// eslint-disable-next-line unicorn/prefer-export-from -- `export * as from 'typescript'` is invalid (typescript uses `export =`); the namespace import + named export form is the only working shape
export { ts }
