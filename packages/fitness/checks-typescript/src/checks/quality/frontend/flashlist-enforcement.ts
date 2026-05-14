/**
 * @fileoverview FlashList Enforcement Check
 *
 * Detects FlatList usage in frontend code and recommends FlashList from @shopify/flash-list.
 * FlatList has performance issues with large lists; FlashList is the recommended alternative.
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Options for checking FlatList usage
 */
interface CheckFlatListOptions {
  node: ts.Node
  sourceFile: ts.SourceFile
  filePath: string
  violations: CheckViolation[]
}

/**
 * Checks for FlatList import from react-native
 * @param {CheckFlatListOptions} options - The check options
 */
function checkFlatListImport(options: CheckFlatListOptions): void {
  const { node, sourceFile, filePath, violations } = options
  // Validate array parameter
  if (!Array.isArray(violations)) {
    return
  }

  if (!ts.isImportDeclaration(node)) return

  const moduleSpecifier = node.moduleSpecifier
  if (!ts.isStringLiteral(moduleSpecifier) || moduleSpecifier.text !== 'react-native') return

  const importClause = node.importClause
  if (!importClause?.namedBindings || !ts.isNamedImports(importClause.namedBindings)) return

  for (const element of importClause.namedBindings.elements) {
    if (element.name.text === 'FlatList') {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(element.getStart())
      violations.push({
        filePath,
        line: line + 1,
        column: character + 1,
        message: 'FlatList imported from react-native',
        severity: 'error',
        type: 'flatlist-import',
        suggestion:
          "Replace with: import { FlashList } from '@shopify/flash-list'. FlashList provides better performance for large lists.",
        match: 'FlatList',
      })
    }
  }
}

/**
 * Checks for FlatList JSX usage
 * @param {CheckFlatListOptions} options - The check options
 */
function checkFlatListJsxUsage(options: CheckFlatListOptions): void {
  const { node, sourceFile, filePath, violations } = options
  // Validate array parameter
  if (!Array.isArray(violations)) {
    return
  }

  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return

  const tagName = node.tagName
  if (!ts.isIdentifier(tagName) || tagName.text !== 'FlatList') return

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

  violations.push({
    filePath,
    line: line + 1,
    column: character + 1,
    message: 'FlatList JSX element used',
    severity: 'error',
    type: 'flatlist-jsx',
    suggestion:
      'Replace <FlatList> with <FlashList> and add estimatedItemSize prop for optimal performance.',
    match: '<FlatList',
  })
}

/**
 * Analyzes a single file for FlatList usage
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Quick filter: skip files without FlatList
  if (!content.includes('FlatList')) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return violations

    const visitNode = (node: ts.Node): void => {
      checkFlatListImport({ node, sourceFile, filePath, violations })
      checkFlatListJsxUsage({ node, sourceFile, filePath, violations })
      ts.forEachChild(node, visitNode)
    }

    visitNode(sourceFile)
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

/**
 * Check: quality/flashlist-enforcement
 *
 * Detects FlatList usage and recommends FlashList from @shopify/flash-list
 * for better performance.
 */
export const flashlistEnforcement = defineCheck({
  id: '2b216c87-7b9e-40ab-8eb0-923fa6aa042a',
  slug: 'flashlist-enforcement',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'high',
  description:
    'Detect FlatList usage and recommend FlashList from @shopify/flash-list for better performance',
  longDescription: `**Purpose:** Prevents usage of React Native's \`FlatList\` in favor of \`FlashList\` from \`@shopify/flash-list\`, which provides significantly better scroll performance.

**Detects:** Analyzes each file individually using TypeScript AST traversal.
- \`FlatList\` named imports from \`react-native\` (checks import declarations)
- \`<FlatList>\` JSX element usage (checks opening and self-closing elements)
- Uses a quick-filter optimization: skips files not containing the string \`FlatList\`

**Why it matters:** \`FlatList\` has known performance issues with large lists, causing frame drops and jank. \`FlashList\` is a drop-in replacement with better memory management and rendering.

**Scope:** Codebase-specific convention`,
  tags: ['quality', 'performance', 'best-practices', 'react-native'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
