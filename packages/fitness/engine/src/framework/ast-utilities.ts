// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Local AST helpers used by the fitness engine itself.
 *
 * The canonical TS compiler-API helpers — parseSource, walkNodes,
 * getIdentifierName, getPropertyChain — live in
 * @opensip-tools/lang-typescript. They are NOT re-exported from here.
 * Check packs import them directly from the language adapter.
 *
 * What remains in this file is the smaller set of node-inspection
 * helpers that fitness exposes through its public barrel for check
 * authors (getLineNumber, isPropertyAccess, isLiteral,
 * isInStringLiteral). These overlap with the lang-typescript versions
 * but the duplication hasn't yet been flagged for migration.
 */

import * as ts from 'typescript'

// =============================================================================
// NODE INSPECTION
// =============================================================================

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

