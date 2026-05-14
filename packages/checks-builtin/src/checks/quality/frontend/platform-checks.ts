/**
 * @fileoverview Platform Checks
 *
 * Validates Platform.OS usage patterns in React Native code.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'

/**
 * Checks if a node is an import declaration from 'react-native'
 * @param node - The AST node to check
 * @returns True if node is an import from react-native
 */
function isReactNativeImport(node: ts.Node): node is ts.ImportDeclaration {
  if (!ts.isImportDeclaration(node)) return false
  if (!ts.isStringLiteral(node.moduleSpecifier)) return false
  return node.moduleSpecifier.text === 'react-native'
}

/**
 * Checks if an import declaration has named bindings
 * @param node - The import declaration to check
 * @returns True if the import has named bindings
 */
function hasNamedBindings(node: ts.ImportDeclaration): boolean {
  if (!node.importClause?.namedBindings) return false
  return ts.isNamedImports(node.importClause.namedBindings)
}

/**
 * Checks if a named import includes 'Platform'
 * @param node - The import declaration with named bindings
 * @returns True if Platform is imported
 */
function importsPlatform(node: ts.ImportDeclaration): boolean {
  const namedBindings = node.importClause?.namedBindings
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return false

  for (const element of namedBindings.elements) {
    if (element.name.text === 'Platform') {
      return true
    }
  }
  return false
}

/**
 * Checks if a node is a Platform.OS property access expression
 * @param node - The AST node to check
 * @returns True if node is Platform.OS
 */
function isPlatformOSAccess(node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false
  if (!ts.isIdentifier(node.expression)) return false
  if (node.expression.text !== 'Platform') return false
  if (!ts.isIdentifier(node.name)) return false
  return node.name.text === 'OS'
}

/**
 * Analyze a file for Platform.OS usage patterns
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Only check TSX files
  if (!filePath.endsWith('.tsx')) {
    return []
  }

  // Quick filter: skip files without Platform references
  if (!content.includes('Platform')) {
    return []
  }

  const violations: CheckViolation[] = []

  const sourceFile = getSharedSourceFile(filePath, content)
  if (!sourceFile) return violations

  // Use state object to track findings across callback invocations
  // (TypeScript can't track primitive mutations in callbacks)
  const state = { hasPlatformImport: false, usesPlatformOS: false }

  const visitNode = (node: ts.Node): void => {
    // Check for Platform import from react-native
    if (isReactNativeImport(node) && hasNamedBindings(node) && importsPlatform(node)) {
      state.hasPlatformImport = true
    }

    // Check for Platform.OS usage
    if (isPlatformOSAccess(node)) {
      state.usesPlatformOS = true
    }

    ts.forEachChild(node, visitNode)
  }

  visitNode(sourceFile)

  // If using Platform.OS without import, flag it
  if (state.usesPlatformOS && !state.hasPlatformImport) {
    violations.push({
      filePath,
      line: 1,
      column: 0,
      message: 'Platform.OS used without importing Platform from react-native',
      severity: 'error',
      suggestion:
        "Add the Platform import at the top of the file: import { Platform } from 'react-native';",
      match: 'Platform.OS',
    })
  }

  return violations
}

/**
 * Check: quality/platform-checks
 *
 * Validates Platform.OS usage patterns in React Native code.
 */
export const platformChecks = defineCheck({
  id: '563aad0d-8e78-436f-a151-6f3752c72fa3',
  slug: 'platform-checks',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'high',
  description: 'Validates Platform.OS usage patterns in React Native code',
  longDescription: `**Purpose:** Validates that \`Platform.OS\` usage in React Native code is backed by a proper import from \`react-native\`.

**Detects:** Analyzes each file individually using TypeScript AST traversal.
- \`Platform.OS\` property access expressions (via \`isPropertyAccessExpression\`) without a corresponding \`import { Platform } from 'react-native'\` named import in the same file
- Tracks both the import declaration and usage separately, then cross-checks at the end
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** Using \`Platform.OS\` without importing \`Platform\` causes runtime reference errors that may not surface until the code runs on a specific platform.

**Scope:** General best practice`,
  tags: ['react-native', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
