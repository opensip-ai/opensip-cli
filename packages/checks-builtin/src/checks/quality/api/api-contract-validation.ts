// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
// @fitness-ignore-file duplicate-utility-functions -- Check-specific helpers (getFunctionName, isHandlerFunction) use check-local types; extracting would couple independent checks
/**
 * @fileoverview API Contract Validation Check
 *
 * Ensures API handlers have proper validation, typed responses, and error handling.
 * Validates that request/response contracts are enforced through types and schemas.
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation, isAPIFile } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

/**
 * Validation detection patterns
 */
const VALIDATION_METHOD_NAMES = new Set([
  'parse',
  'safeParse',
  'validate',
  'validateRequest',
  'validateBody',
  'validateParams',
  'validateQuery',
])

/**
 * Handler name patterns
 */
const HANDLER_NAME_PATTERNS = [/handler$/i, /^handle[A-Z]/, /^process[A-Z]/]

/**
 * Function-like node types that can be API handlers
 */
type FunctionLikeNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.MethodDeclaration

/**
 * Options for checking function contract
 */
interface CheckFunctionContractOptions {
  absolutePath: string
  sourceFile: ts.SourceFile
  node: FunctionLikeNode
}

/**
 * Get function name from node
 * @returns {string} The function name or '<anonymous>' if not found
 */
function getFunctionName(node: FunctionLikeNode): string {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  // Combined condition for arrow function with variable declaration
  if (
    ts.isArrowFunction(node) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text
  }
  return '<anonymous>'
}

/**
 * Check if function has Express handler signature
 * @returns {boolean} True if the function has Express handler signature (req, res)
 */
function hasExpressHandlerSignature(node: FunctionLikeNode): boolean {
  const params = node.parameters
  if (params.length < 2) return false

  const getParamName = (p: ts.ParameterDeclaration | undefined) =>
    p && ts.isIdentifier(p.name) ? p.name.text : ''

  const param1 = getParamName(params[0])
  const param2 = getParamName(params[1])

  return (param1 === 'req' || param1 === 'request') && (param2 === 'res' || param2 === 'response')
}

/**
 * Check if function name suggests it's a handler
 * @returns {boolean} True if the function appears to be a handler
 */
function isHandlerFunction(name: string, filePath: string, node: FunctionLikeNode): boolean {
  if (!isAPIFile(filePath)) return false

  // Check if exported
  let isExported = false
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  } else if (ts.isArrowFunction(node) && ts.isVariableDeclaration(node.parent)) {
    const varStatement = node.parent.parent.parent
    if (ts.isVariableStatement(varStatement)) {
      isExported =
        varStatement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
    }
  } else {
    // Other node types remain isExported = false (initial value)
  }

  if (!isExported) return false
  return HANDLER_NAME_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Check if function should be skipped
 * @returns {boolean} True if the function should be skipped in validation
 */
function shouldSkipFunction(
  node: FunctionLikeNode,
  functionName: string,
  filePath: string,
): boolean {
  if (ts.isMethodDeclaration(node)) {
    const isPrivate = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
    if (isPrivate) return true
  }

  const isExpressHandler = hasExpressHandlerSignature(node)
  if (functionName === '<anonymous>' && isExpressHandler) return true
  if (!isExpressHandler && !isHandlerFunction(functionName, filePath, node)) return true

  return false
}

/**
 * Check if function has request parameter
 * @returns {boolean} True if the function has a request parameter
 */
function hasRequestParameter(node: FunctionLikeNode): boolean {
  return node.parameters.some((param) => {
    if (!ts.isIdentifier(param.name)) return false
    const name = param.name.text
    return name === 'req' || name === 'request' || name.includes('Request')
  })
}

/**
 * Check if a call expression is a validation method call
 */
function isValidationMethodCall(n: ts.CallExpression): boolean {
  if (ts.isPropertyAccessExpression(n.expression)) {
    return VALIDATION_METHOD_NAMES.has(n.expression.name.text)
  }
  if (ts.isIdentifier(n.expression)) {
    return n.expression.text.toLowerCase().includes('validate')
  }
  return false
}

/**
 * Check if function has validation logic
 * @returns {boolean} True if the function has validation logic
 */
function hasRequestValidation(node: FunctionLikeNode): boolean {
  let hasValidation = false

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isValidationMethodCall(n)) {
      hasValidation = true
    }
    if (!hasValidation) ts.forEachChild(n, visit)
  }

  if (node.body) visit(node.body)
  return hasValidation
}

/**
 * Check if function has try-catch block
 * @returns {boolean} True if the function has a try-catch block
 */
function hasTryCatchBlock(node: FunctionLikeNode): boolean {
  let hasTryCatch = false
  const visit = (n: ts.Node) => {
    if (ts.isTryStatement(n)) hasTryCatch = true
    if (!hasTryCatch) ts.forEachChild(n, visit)
  }
  visit(node)
  return hasTryCatch
}

/**
 * Check if function has untyped parameters
 * @returns {boolean} True if the function has any untyped parameters
 */
function hasUntypedParameters(node: FunctionLikeNode): boolean {
  return node.parameters.some((param) => !param.type)
}

/**
 * Check if function has proper API contract
 * @param {CheckFunctionContractOptions} options - The contract check options
 * @returns {CheckViolation[]} Array of contract violations found
 */
function checkFunctionContract(options: CheckFunctionContractOptions): CheckViolation[] {
  const { absolutePath, sourceFile, node } = options
  const violations: CheckViolation[] = []
  const functionName = getFunctionName(node)

  if (shouldSkipFunction(node, functionName, absolutePath)) {
    return violations
  }

  const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const line = lineIdx + 1
  const functionSignature =
    node.getText(sourceFile).split('{')[0]?.trim().slice(0, 100) ?? functionName

  // Check 1: Has explicit return type
  if (!node.type) {
    violations.push({
      line,
      column: character + 1,
      message: `Handler '${functionName}' missing explicit return type`,
      severity: 'error',
      suggestion: `Add explicit return type to '${functionName}', e.g., ': Promise<ServiceResult<T>>' or ': Promise<Response<T>>'`,
      type: 'missing-response-type',
      match: functionSignature,
    })
  }

  // Check 2: Has typed parameters
  if (hasUntypedParameters(node)) {
    violations.push({
      line,
      column: character + 1,
      message: `Handler '${functionName}' has untyped parameters`,
      severity: 'error',
      suggestion: `Add explicit TypeScript types to all parameters in '${functionName}' for type safety`,
      type: 'untyped-parameters',
      match: functionSignature,
    })
  }

  // Check 3: Has validation for request parameters
  if (!hasRequestValidation(node) && hasRequestParameter(node)) {
    violations.push({
      line,
      column: character + 1,
      message: `Handler '${functionName}' accepts request but has no validation`,
      severity: 'error',
      suggestion: `Add Zod schema validation using .parse() or .safeParse() for request body/params in '${functionName}'`,
      type: 'missing-validation',
      match: functionSignature,
    })
  }

  // Check 4: Has try-catch for error handling
  if (!hasTryCatchBlock(node)) {
    violations.push({
      line,
      column: character + 1,
      message: `Handler '${functionName}' missing try-catch error handling`,
      severity: 'warning',
      suggestion: `Wrap the body of '${functionName}' in try-catch to handle errors gracefully and return appropriate error responses`,
      type: 'missing-error-handling',
      match: functionSignature,
    })
  }

  return violations
}

/**
 * Analyze a file for API contract violations
 * @returns {CheckViolation[]} Array of violations found in the file
 */
function analyzeFile(absolutePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  const sourceFile = getSharedSourceFile(absolutePath, content)
    if (!sourceFile) return []

  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const nodeViolations = checkFunctionContract({
        absolutePath,
        sourceFile,
        node,
      })
      violations.push(...nodeViolations)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/**
 * Check: quality/api-contract-validation
 *
 * Validates that API handlers have proper validation, typed responses,
 * and error handling for type safety and reliability.
 *
 */
export const apiContractValidation = defineCheck({
  id: 'ef307717-de39-41d3-8344-0e6f7562367a',
  slug: 'api-contract-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Validate API handlers have proper validation, typed responses, and error handling',
  longDescription: `**Purpose:** Enforces that API handler functions have proper type contracts, input validation, and error handling.

**Detects:**
- Handlers (matching \`/handler$/i\`, \`/^handle[A-Z]/\`, \`/^process[A-Z]/\`) missing explicit return types
- Handler parameters without TypeScript type annotations
- Handlers accepting \`req\`/\`request\` params without calling \`parse\`, \`safeParse\`, \`validate\`, or similar validation methods
- Handler bodies missing try-catch error handling

**Why it matters:** Untyped or unvalidated API handlers allow malformed requests through and produce unpredictable error responses.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing. Only processes files identified as API files by \`isAPIFile()\`.`,
  tags: ['quality', 'api', 'type-safety', 'validation'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Only analyze API files
    if (!isAPIFile(filePath)) {
      return []
    }

    try {
      return analyzeFile(filePath, content)
    } catch {
      // @swallow-ok Skip files that fail to parse
      return []
    }
  },
})
