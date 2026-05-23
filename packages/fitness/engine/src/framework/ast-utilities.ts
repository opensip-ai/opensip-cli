/**
 * @fileoverview Local AST helpers used by the fitness engine itself.
 *
 * Most TS compiler-API helpers — parseSource, walkNodes,
 * getIdentifierName, getPropertyChain, isLiteral, isInStringLiteral —
 * live in @opensip-tools/lang-typescript. They are NOT re-exported
 * from here. Check packs import them directly from the language
 * adapter.
 *
 * What remains in this file is the narrow set of node-inspection
 * helpers that fitness still exposes through its public barrel for
 * check authors:
 *
 *   - getASTLineNumber → 1-indexed line number for a TS node.
 *     Deliberately distinct from result-builder's `getLineNumber`,
 *     which takes `(content: string, index: number)` rather than a
 *     node + source file. One name, one signature.
 *   - isPropertyAccess → property-name-aware wrapper around
 *     `ts.isPropertyAccessExpression`. Used by checks that want to
 *     match a specific member like `.method()`.
 *
 * Both have lang-typescript counterparts but are kept here because
 * the duplication hasn't been flagged for migration yet.
 */

import * as ts from 'typescript'

/**
 * Get the 1-indexed line number for a node.
 */
export function getASTLineNumber(node: ts.Node, sourceFile: ts.SourceFile): number {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  return line + 1
}

/**
 * Check if a node is a property access matching a specific property name.
 */
export function isPropertyAccess(node: ts.Node, propertyName: string): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === propertyName
}
