// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
// @fitness-ignore-file duplicate-utility-functions -- Check-specific helpers (isHandlerFunction, getFunctionName) are typed for this check's node types; extracting would couple independent checks
/**
 * @fileoverview Clean Code Function Parameter Count check
 *
 * Enforces Clean Code principles for function parameter counts.
 * Functions with too many parameters indicate design issues and should
 * use options objects or builder patterns instead.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

/**
 * Clean Code thresholds
 */
const PARAM_COUNT_WARNING = 4 // 3 params is acceptable, 4 is borderline
const PARAM_COUNT_ERROR = 5 // Requires refactoring

// Lenient thresholds for special cases
const CONSTRUCTOR_WARNING = 5 // Dependency injection
const CONSTRUCTOR_ERROR = 8
const FACTORY_WARNING = 4
const FACTORY_ERROR = 6
const HANDLER_WARNING = 5 // Route handlers often have (request, reply, context, etc.)
const HANDLER_ERROR = 7

/**
 * Paths where parameter count requirements are relaxed
 * These are typically internal/infrastructure code with legitimate multi-param functions
 */
const RELAXED_PATHS = [
  /\/internal\//,
  /\/cli\//,
  /\/scripts\//,
  /\/utils\//,
  /\/helpers\//,
  /\/bin\//,
]

/**
 * Function name patterns that are allowed more parameters
 * These are common framework/infrastructure patterns
 */
const HANDLER_PATTERNS = [
  /^handle[A-Z]/, // Event handlers
  /Handler$/, // Handler methods
  /^on[A-Z]/, // Callbacks
  /Callback$/, // Callback functions
  /^register/i, // Registration functions
  /^configure/i, // Configuration functions
  /^bootstrap/i, // Bootstrap functions
  /^initialize/i, // Initialization functions
]

/**
 * Check if file is in a relaxed validation path
 */
function isRelaxedPath(filePath: string): boolean {
  return RELAXED_PATHS.some((pattern) => pattern.test(filePath))
}

/**
 * Check if function name indicates a handler pattern
 */
function isHandlerFunction(name: string): boolean {
  return HANDLER_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Check if node is an abstract method or interface method signature
 */
function isAbstractOrInterfaceMethod(node: ts.FunctionLikeDeclaration): boolean {
  // Abstract method
  if (
    ts.isMethodDeclaration(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
  ) {
    return true
  }

  // Interface method signature
  if (ts.isMethodSignature(node.parent)) {
    return true
  }

  // Method declaration inside interface
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Defensive: node.parent always set in TS AST but checking for traversal safety
  if (node.parent && ts.isInterfaceDeclaration(node.parent.parent)) {
    return true
  }

  return false
}

/**
 * Get function name from node
 */
function getFunctionName(node: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor'
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text
  }
  return '<anonymous>'
}

/**
 * Get function type for threshold selection
 */
function getFunctionType(node: ts.FunctionLikeDeclaration, name: string): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (isHandlerFunction(name)) return 'handler'
  if (ts.isMethodDeclaration(node)) return 'method'
  if (ts.isArrowFunction(node)) return 'arrow function'
  if (/^(create|make|build)/i.test(name)) return 'factory'
  return 'function'
}

/**
 * Analyze a file for parameter count issues
 */
function analyzeFile(filePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // Skip files in relaxed paths (if not already excluded)
  if (isRelaxedPath(filePath)) {
    return violations
  }

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      const isNamedFunction = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      const isConstructor = ts.isConstructorDeclaration(node)
      const isAnonymousFunction = ts.isArrowFunction(node) || ts.isFunctionExpression(node)

      if (isNamedFunction || isConstructor || isAnonymousFunction) {
        const funcNode = node as ts.FunctionLikeDeclaration
        const paramCount = funcNode.parameters.length
        const functionName = getFunctionName(funcNode)
        const functionType = getFunctionType(funcNode, functionName)

        // Skip abstract methods and interface signatures (they're type declarations)
        if (isAbstractOrInterfaceMethod(funcNode)) {
          ts.forEachChild(node, visit)
          return
        }

        // Determine thresholds based on function type
        let warningThreshold = PARAM_COUNT_WARNING
        let errorThreshold = PARAM_COUNT_ERROR

        if (functionType === 'constructor') {
          warningThreshold = CONSTRUCTOR_WARNING
          errorThreshold = CONSTRUCTOR_ERROR
        } else if (functionType === 'factory') {
          warningThreshold = FACTORY_WARNING
          errorThreshold = FACTORY_ERROR
        } else if (functionType === 'handler' || isHandlerFunction(functionName)) {
          warningThreshold = HANDLER_WARNING
          errorThreshold = HANDLER_ERROR
        }

        // Check thresholds
        if (paramCount >= errorThreshold) {
          const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(),
          )
          const line = lineIdx + 1
          const paramList = funcNode.parameters.map((p) => p.getText(sourceFile)).join(', ')

          violations.push({
            line,
            column: character + 1,
            message: `${functionType} '${functionName}' has ${paramCount} parameters (limit: ${errorThreshold})`,
            severity: 'error',
            suggestion: `Refactor '${functionName}' to use an options object pattern: replace individual parameters with a single 'options: ${functionName}Options' parameter containing { ${paramList.slice(0, 60)}... }`,
            type: 'excessive-parameters',
            match: `${functionName}(${paramList.slice(0, 40)}...)`,
            filePath,
          })
        } else if (paramCount > warningThreshold) {
          const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(),
          )
          const line = lineIdx + 1
          const paramList = funcNode.parameters.map((p) => p.getText(sourceFile)).join(', ')

          violations.push({
            line,
            column: character + 1,
            message: `${functionType} '${functionName}' has ${paramCount} parameters (recommended: ${warningThreshold})`,
            severity: 'warning',
            suggestion: `Consider refactoring '${functionName}' to use options object to improve readability and maintainability`,
            type: 'many-parameters',
            match: `${functionName}(${paramList.slice(0, 40)}...)`,
            filePath,
          })
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Ignore parse errors
  }

  return violations
}

/**
 * Check: quality/clean-code-function-parameters
 *
 * Ensures functions have minimal parameters following Clean Code principles.
 * 0-2 ideal, 3+ warning, 5+ error.
 */
export const cleanCodeFunctionParameters = defineCheck({
  id: 'fccfbaff-d492-492e-ad09-21b7abb2b8b6',
  slug: 'clean-code-function-parameters',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',
  confidence: 'high',
  description: 'Ensure functions have minimal parameters (0-2 ideal, 3+ warning, 5+ error)',
  longDescription: `**Purpose:** Enforces Clean Code principles for function parameter counts, requiring functions to use options objects or builder patterns instead of long parameter lists.

**Detects:** Analyzes each file individually using TypeScript AST traversal.
- Functions with 4+ parameters (warning) or 5+ parameters (error)
- Constructors with 5+ parameters (warning) or 8+ parameters (error)
- Factory functions (\`create\`, \`make\`, \`build\` prefixes) with 4+/6+ parameters
- Handler functions (\`handle*\`, \`on*\`, \`*Handler\`, \`*Callback\`) with 5+/7+ parameters

**Why it matters:** Functions with too many parameters are hard to call correctly, difficult to test, and indicate the function is doing too much. Options objects improve readability and extensibility.

**Scope:** General best practice (Clean Code Ch.3)`,
  tags: ['quality', 'clean-code', 'maintainability', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    return analyzeFile(filePath, content)
  },
})
