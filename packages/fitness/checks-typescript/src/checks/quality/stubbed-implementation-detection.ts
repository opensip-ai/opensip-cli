// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file stubbed-implementation-detection -- longDescription documents the patterns this check detects, triggering self-detection
/**
 * @fileoverview Stubbed Implementation Detection Check
 *
 * Detects patterns indicating incomplete or placeholder implementations:
 * - Empty object stubs: `({}) as Type`
 * - Promise.resolve() placeholders
 * - Hardcoded stub returns
 * - Placeholder comments
 *
 * False-positive reduction: the check walks the AST for context to skip:
 *   - Promise.resolve() in lifecycle methods (destroy/dispose/close/shutdown/cleanup)
 *   - Promise.resolve() inside conditional blocks (guard clauses)
 *   - Promise.resolve() in functions with substantive statements
 *   - { success: true, data: [] } inside conditional branches or functions with multiple returns
 *   - ({}) as T where T is a generic type parameter
 *   - ({}) as T used as Proxy target
 */


import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'
import {
  findEnclosingFunctionBody,
  getEnclosingFunctionName,
  getSharedSourceFile,
  isInsideConditionalBlock,
} from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/** The check ID constant to avoid duplication */
const CHECK_SLUG = 'stubbed-implementation-detection'
const CHECK_ID = '12218d58-5dea-4aba-ba7b-fc1822d03ec4'

/** Placeholder comment patterns - using explicit RegExp constructors for safety */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\/\/\s*Placeholder\s*(implementation|for|:|-)`, 'i'),
  new RegExp(String.raw`\/\/\s*STUB\s*[:|-]`, 'i'),
  new RegExp(String.raw`\/\/\s*Not\s+implemented`, 'i'),
]

/** Primitive types that should be skipped when checking empty object stubs */
const PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'void',
  'never',
  'unknown',
])

/** Pattern for Promise.resolve stubs - matches exact form without backtracking */
const PROMISE_RESOLVE_PATTERN = new RegExp(
  String.raw`^Promise\.resolve\((undefined|null|void 0)?\)$`,
)

/** Pattern for hardcoded stub returns with success: true */
const STUB_RETURN_PATTERN = new RegExp(
  String.raw`success:\s*true[\s\S]*data:\s*(\[\]|null|\{\})`,
  'i',
)

/** Lifecycle teardown method names that commonly return Promise.resolve() */
const LIFECYCLE_METHOD_NAMES = new Set(['destroy', 'dispose', 'close', 'shutdown', 'cleanup'])

interface CheckNodeOptions {
  node: ts.Node
  sourceFile: ts.SourceFile
}

// =============================================================================
// AST HELPER UTILITIES
// =============================================================================
// Function-scope helpers (findEnclosingFunctionBody, getEnclosingFunctionName,
// isInsideConditionalBlock) are imported from @opensip-tools/lang-typescript.

/**
 * Check whether a function body contains substantive statements beyond a single return.
 * "Substantive" means assignments, method calls, logging, variable declarations with initializers, etc.
 */
function functionBodyHasSubstantiveStatements(body: ts.Block, returnNode: ts.Node): boolean {
  for (const stmt of body.statements) {
    // Skip the return statement itself
    if (stmt === returnNode) continue
    // Skip variable declarations without initializers (just type annotations)
    if (ts.isVariableStatement(stmt)) {
      const hasInitializer = stmt.declarationList.declarations.some(
        (d) => d.initializer !== undefined,
      )
      if (hasInitializer) return true
      continue
    }
    // Any other statement (expression statement, if, for, etc.) is substantive
    return true
  }
  return false
}

/**
 * Recursively check if a node contains an await or call expression before a given position.
 */
function containsAwaitOrCallBefore(node: ts.Node, returnPos: number): boolean {
  if (node.getStart() >= returnPos) return false
  if (ts.isAwaitExpression(node)) return true
  if (ts.isCallExpression(node) && node.getStart() < returnPos) return true

  let found = false
  ts.forEachChild(node, (child) => {
    if (!found && containsAwaitOrCallBefore(child, returnPos)) {
      found = true
    }
  })
  return found
}

function functionBodyHasAwaitOrCallsBefore(body: ts.Block, returnNode: ts.Node): boolean {
  const returnPos = returnNode.getStart()

  for (const stmt of body.statements) {
    if (stmt === returnNode) break
    if (containsAwaitOrCallBefore(stmt, returnPos)) return true
  }
  return false
}

/**
 * Check whether the function has multiple return statements (indicating branches, not a stub).
 */
function functionHasMultipleReturns(body: ts.Block): boolean {
  let returnCount = 0
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      returnCount++
    }
    // Do not descend into nested functions
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return
    }
    ts.forEachChild(node, visit)
  }
  for (const stmt of body.statements) {
    visit(stmt)
  }
  return returnCount > 1
}

/**
 * Check whether a node's type parameters include the given type name.
 */
function nodeHasTypeParameter(
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.ClassDeclaration,
  typeText: string,
  sourceFile: ts.SourceFile,
): boolean {
  if (!node.typeParameters) return false
  return node.typeParameters.some((tp) => tp.name.getText(sourceFile) === typeText)
}

/**
 * Check whether the type in an as-expression refers to a generic type parameter
 * rather than a concrete type. Walks up the AST to find enclosing function/class
 * type parameters and checks if the cast target matches one.
 */
function isGenericTypeParameter(
  typeText: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): boolean {
  let current: ts.Node = node.parent
  while (!ts.isSourceFile(current)) {
    // Check function-like or class declarations for type parameters
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isClassDeclaration(current)) &&
      nodeHasTypeParameter(current, typeText, sourceFile)
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

/**
 * Check whether the as-expression is the target argument of a `new Proxy(...)` call.
 */
function isProxyTarget(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const parent = node.parent

  // Direct parent should be a NewExpression: new Proxy({} as T, handler)
  if (ts.isNewExpression(parent)) {
    const exprText = parent.expression.getText(sourceFile)
    if (exprText === 'Proxy' && parent.arguments?.[0] === node) {
      return true
    }
  }

  // Or it could be wrapped in parentheses: new Proxy(({} as T), handler)
  if (ts.isParenthesizedExpression(parent)) {
    return isProxyTarget(parent, sourceFile)
  }

  return false
}

// =============================================================================
// CHECK FUNCTIONS
// =============================================================================

function checkEmptyObjectStub(options: CheckNodeOptions): CheckViolation | null {
  const { node, sourceFile } = options
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return null

  const expression = node.expression
  if (!ts.isObjectLiteralExpression(expression) || expression.properties.length > 0) return null

  const typeText = node.type.getText(sourceFile)
  // Skip primitives and Record types
  const isPrimitive = PRIMITIVE_TYPES.has(typeText)
  const isRecordType = typeText.startsWith('Record<') && typeText.endsWith('>')

  if (isPrimitive || isRecordType) return null

  // Skip if type is a generic type parameter (e.g., T in deepMerge<T>)
  if (isGenericTypeParameter(typeText, node, sourceFile)) return null

  // Skip if this is the target of a new Proxy(...) call
  if (isProxyTarget(node, sourceFile)) return null

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const matchText = node.getText(sourceFile)

  return {
    line: lineNum,
    column: character + 1,
    message: `Empty object stub: ({}) as ${typeText} - will crash at runtime`,
    severity: 'error',
    suggestion: `Implement the actual ${typeText} object with all required properties, or use a factory function/builder to create valid instances`,
    match: matchText,
  }
}

function checkPromiseResolveStub(options: CheckNodeOptions): CheckViolation | null {
  const { node, sourceFile } = options
  if (!ts.isReturnStatement(node) || !node.expression || !ts.isCallExpression(node.expression))
    return null

  const callText = node.expression.getText(sourceFile)

  if (!PROMISE_RESOLVE_PATTERN.test(callText)) return null

  // Skip if inside a conditional block (guard clause / early return)
  if (isInsideConditionalBlock(node)) return null

  // Skip if enclosing function is a lifecycle teardown method
  const funcName = getEnclosingFunctionName(node, sourceFile)
  if (funcName && LIFECYCLE_METHOD_NAMES.has(funcName)) return null

  // Skip if the function body has substantive statements (real work + async wrapping)
  const body = findEnclosingFunctionBody(node)
  if (body && functionBodyHasSubstantiveStatements(body, node)) return null

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

  return {
    line: line + 1,
    column: character + 1,
    message: 'Placeholder return: Promise.resolve() - method does nothing',
    severity: 'error',
    suggestion:
      'Implement the actual async logic for this method, or if this is intentional no-op, add a comment explaining why',
    match: callText,
  }
}

function checkHardcodedStubReturn(options: CheckNodeOptions): CheckViolation | null {
  const { node, sourceFile } = options
  if (
    !ts.isReturnStatement(node) ||
    !node.expression ||
    !ts.isObjectLiteralExpression(node.expression)
  )
    return null

  const returnText = node.expression.getText(sourceFile)

  if (!STUB_RETURN_PATTERN.test(returnText)) return null

  // Skip if inside a conditional block (branch return, not the only path)
  if (isInsideConditionalBlock(node)) return null

  // Skip if the function has multiple return statements (indicates branching logic)
  const body = findEnclosingFunctionBody(node)
  if (body && functionHasMultipleReturns(body)) return null

  // Skip if the function body contains await expressions or calls before this return
  if (body && functionBodyHasAwaitOrCallsBefore(body, node)) return null

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

  return {
    line: line + 1,
    column: character + 1,
    message: 'Hardcoded stub return: { success: true, data: [] }',
    severity: 'warning',
    suggestion: 'Replace this stub with actual implementation that fetches/processes real data',
    match: returnText.slice(0, 80),
  }
}

function checkLineForPlaceholder(line: string, lineNum: number): CheckViolation | null {
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(line)) {
      return {
        line: lineNum,
        column: 0,
        message: 'Placeholder comment indicates unfinished implementation',
        severity: 'warning',
        suggestion:
          'Complete the implementation or create a ticket to track this work, then remove the placeholder comment',
        match: line.trim(),
      }
    }
  }
  return null
}

/**
 * Check: quality/stubbed-implementation-detection
 *
 * Detects incomplete or placeholder implementations.
 */
export const stubbedImplementationDetection = defineCheck({
  id: CHECK_ID,
  slug: CHECK_SLUG,
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  confidence: 'high',
  description: 'Detects incomplete/placeholder implementations',
  longDescription: `**Purpose:** Detects incomplete or placeholder implementations that will fail at runtime or silently do nothing.

**Detects:**
- Empty object stubs: \`({}) as Type\` where Type is not a primitive or Record (will crash at runtime)
- Placeholder returns: \`return Promise.resolve(undefined|null|void 0)\` indicating a no-op async method
- Hardcoded stub returns: \`return { success: true, data: []|null|{} }\` patterns
- Placeholder comments: \`// Placeholder implementation\`, \`// STUB:\`, \`// Not implemented\`

**Skips (not false positives):**
- Promise.resolve() in lifecycle methods (destroy, dispose, close, shutdown, cleanup)
- Promise.resolve() inside conditional blocks (guard clauses)
- Promise.resolve() in functions with substantive statements (real synchronous work)
- Hardcoded stub returns inside conditional branches or functions with multiple returns
- Hardcoded stub returns in functions with await/call expressions before the return
- \`({}) as T\` where T is a generic type parameter
- \`({}) as T\` used as a Proxy target

**Why it matters:** Stubbed implementations pass type checks but fail at runtime. Detecting them early prevents production crashes and silent data loss.

**Scope:** General best practice. Analyzes each file individually (\`analyze\`). Uses TypeScript AST parsing on production files (excludes tests and fixtures).`,
  tags: ['quality', 'code-quality', 'best-practices'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath): CheckViolation[] {
    const violations: CheckViolation[] = []

    try {
      const sourceFile = getSharedSourceFile(filePath, content)
      if (!sourceFile) return []

      const visit = (node: ts.Node): void => {
        const nodeOptions = { node, sourceFile }

        const emptyStub = checkEmptyObjectStub(nodeOptions)
        if (emptyStub) violations.push(emptyStub)

        const promiseStub = checkPromiseResolveStub(nodeOptions)
        if (promiseStub) violations.push(promiseStub)

        const hardcodedStub = checkHardcodedStubReturn(nodeOptions)
        if (hardcodedStub) violations.push(hardcodedStub)

        ts.forEachChild(node, visit)
      }

      visit(sourceFile)

      // Check for placeholder comments (skip test files — placeholder comments
      // in tests are intentional)
      if (!isTestFile(filePath)) {
        const lines = content.split('\n')
        for (const [i, line] of lines.entries()) {
          const placeholder = checkLineForPlaceholder(line ?? '', i + 1)
          if (placeholder) violations.push(placeholder)
        }
      }
    } catch {
      // @swallow-ok Skip files that fail to parse
    }

    return violations
  },
})
