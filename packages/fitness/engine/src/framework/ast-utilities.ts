// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Shared AST utilities for fitness checks
 *
 * Common TypeScript AST operations for source parsing, tree walking,
 * and node inspection. Used by AST-based fitness checks.
 */

import * as ts from 'typescript'

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
    // @swallow-ok Parse failure returns null for graceful degradation
    return null
  }
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

