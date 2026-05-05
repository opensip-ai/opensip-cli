// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Mutable Exported Constants Check
 *
 * Detects exported const objects/arrays without Object.freeze() or 'as const'.
 * Mutable exported constants can lead to unexpected behavior and bugs.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

/**
 * Excluded patterns where mutable exports are acceptable
 */
const EXCLUDED_PATTERNS = [
  /\/config\/defaults\.ts$/,
  /\/config\/presets\.ts$/,
  /\/testing\//,
  /\/__tests__\//,
  /\/test-scenarios\.ts$/,
  /\/test-patterns\.ts$/,
]

// =============================================================================
// AST HELPERS
// =============================================================================

/**
 * Check if expression has 'as const' assertion
 */
function hasAsConstAssertion(node: ts.Expression): boolean {
  if (ts.isAsExpression(node.parent)) {
    const typeNode = node.parent.type
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      return typeNode.typeName.text === 'const'
    }
  }
  return false
}

/**
 * Check if declaration is wrapped in Object.freeze()
 */
function isWrappedInFreeze(declaration: ts.VariableDeclaration): boolean {
  if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) {
    return false
  }

  const expression = declaration.initializer.expression
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Object' &&
      expression.name.text === 'freeze'
    )
  }

  return false
}

/**
 * Check if a variable statement is exported
 */
function isExportedStatement(node: ts.VariableStatement): boolean {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

// =============================================================================
// VIOLATION DETECTION
// =============================================================================

/**
 * Check if an initializer needs a mutable constant violation
 */
function isMutableInitializer(
  declaration: ts.VariableDeclaration,
  initializer: ts.Expression,
): boolean {
  const isObjectLiteral = ts.isObjectLiteralExpression(initializer)
  const isArrayLiteral = ts.isArrayLiteralExpression(initializer)

  if (!isObjectLiteral && !isArrayLiteral) {
    return false
  }

  return !hasAsConstAssertion(initializer) && !isWrappedInFreeze(declaration)
}

/**
 * Get the violation type based on initializer
 */
function getViolationType(initializer: ts.Expression): 'mutable-object' | 'mutable-array' | null {
  if (ts.isObjectLiteralExpression(initializer)) {
    return 'mutable-object'
  }
  if (ts.isArrayLiteralExpression(initializer)) {
    return 'mutable-array'
  }
  return null
}

interface CreateMutableConstViolationOptions {
  lineNum: number
  constantName: string
  violationType: 'mutable-object' | 'mutable-array'
}

/**
 * Create a violation for a mutable exported constant
 */
function createMutableConstViolation(options: CreateMutableConstViolationOptions): CheckViolation {
  const { lineNum, constantName, violationType } = options
  const isObject = violationType === 'mutable-object'
  const bracket = isObject ? '{ ... }' : '[ ... ]'
  const typeLabel = isObject ? 'object' : 'array'

  return {
    line: lineNum,
    column: 0,
    message: `Exported const '${constantName}' is a mutable ${typeLabel}`,
    severity: 'warning',
    type: violationType,
    suggestion: `Add 'as const' assertion: export const ${constantName} = ${bracket} as const; Or wrap with Object.freeze()`,
    match: constantName,
  }
}

interface CheckDeclarationOptions {
  declaration: ts.VariableDeclaration
  sourceFile: ts.SourceFile
}

/**
 * Check a single declaration for mutable constant issues
 */
function checkDeclaration(options: CheckDeclarationOptions): CheckViolation | null {
  const { declaration, sourceFile } = options
  if (!declaration.initializer || !ts.isIdentifier(declaration.name)) {
    return null
  }

  const initializer = declaration.initializer
  if (!isMutableInitializer(declaration, initializer)) {
    return null
  }

  const violationType = getViolationType(initializer)
  if (!violationType) {
    return null
  }

  const constantName = declaration.name.text
  const { line } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart())
  const lineNum = line + 1

  return createMutableConstViolation({
    lineNum,
    constantName,
    violationType,
  })
}

interface ProcessExportedStatementOptions {
  node: ts.VariableStatement
  sourceFile: ts.SourceFile
  violations: CheckViolation[]
}

/**
 * Process an exported variable statement
 */
function processExportedStatement(options: ProcessExportedStatementOptions): void {
  const { node, sourceFile, violations } = options
  for (const declaration of node.declarationList.declarations) {
    const violation = checkDeclaration({
      declaration,
      sourceFile,
    })
    if (violation) {
      violations.push(violation)
    }
  }
}

// =============================================================================
// FILE ANALYSIS
// =============================================================================

/**
 * Analyze a file for mutable exported constants
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip excluded patterns
  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return violations
  }

  let sourceFile: ts.SourceFile | null
  try {
    sourceFile = getSharedSourceFile(filePath, content)
  } catch {
    // @swallow-ok Skip files that fail to parse
    return violations
  }
  if (!sourceFile) return violations

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && isExportedStatement(node)) {
      processExportedStatement({ node, sourceFile, violations })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/mutable-exported-constants
 *
 * Detects exported const objects/arrays without Object.freeze() or as const.
 */
export const mutableExportedConstants = defineCheck({
  id: 'd9d43de6-8f2a-4da7-9d24-bc1b30f4e611',
  slug: 'mutable-exported-constants',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect exported const objects/arrays without Object.freeze() or as const',
  longDescription: `**Purpose:** Detects exported \`const\` declarations initialized with object literals or array literals that lack immutability protection.

**Detects:** Analyzes each file individually using TypeScript AST. Flags exported \`const\` variable declarations where the initializer is an \`ObjectLiteralExpression\` or \`ArrayLiteralExpression\` without an \`as const\` type assertion or \`Object.freeze()\` wrapper.

**Why it matters:** Exported mutable objects/arrays can be accidentally modified by any importer, causing shared state bugs that are difficult to trace across module boundaries.

**Scope:** General best practice`,
  tags: ['quality', 'type-safety', 'best-practices'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath) {
    // Quick filter: skip files without export statements
    if (!content.includes('export ')) {
      return []
    }

    return analyzeFile(content, filePath)
  },
})
