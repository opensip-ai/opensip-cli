/**
 * @fileoverview TypeScript AST utilities
 * @version 1.0.0
 *
 * Utilities for working with TypeScript AST nodes.
 * These are generic helpers used across fitness checks for TypeScript analysis.
 */

import * as ts from 'typescript'

/**
 * Check if a TypeScript AST node has an export modifier.
 *
 * Works with any node type that can have modifiers:
 * - FunctionDeclaration
 * - ClassDeclaration
 * - VariableStatement
 * - InterfaceDeclaration
 * - TypeAliasDeclaration
 * - EnumDeclaration
 * - etc.
 *
 * @param node - The TypeScript AST node to check
 * @returns True if the node has an export keyword modifier
 *
 * @example
 * // For: export function foo() {}
 * hasExportModifier(functionNode) // true
 *
 * // For: function bar() {}
 * hasExportModifier(functionNode) // false
 */
export function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false
  }
  const modifiers = ts.getModifiers(node)
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

