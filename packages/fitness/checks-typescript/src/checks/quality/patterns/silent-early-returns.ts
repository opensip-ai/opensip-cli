/**
 * @fileoverview Silent Early Returns Check
 *
 * Detects validation/guard paths that return silently without logging.
 * These patterns make debugging difficult by hiding why code paths weren't executed.
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

// =============================================================================
// DETECTION PATTERNS
// =============================================================================

/** Function-like AST nodes this check operates on. */
type FunctionLikeNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction

/**
 * Patterns that indicate logging is present
 */
const LOGGING_PATTERNS = [/logger\./, /console\./, /\.log\(/]

/**
 * Patterns that indicate intentional silent return
 */
const MARKER_PATTERNS = [/@silent-ok/, /\/\/\s*type\s*guard/i]

/**
 * Sentinel return value kinds
 */
const SENTINEL_KINDS = new Set([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.FalseKeyword])

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Find the enclosing function for a node
 */
function findFunction(
  node: ts.Node,
): FunctionLikeNode | null {
  let current = node.parent
   
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isArrowFunction(current)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

/**
 * Check if a function is a type guard or boolean predicate
 * - Type guards: functions that return `x is T`
 * - Predicate functions: isXxx, hasXxx, canXxx, shouldXxx
 */
function isTypeGuard(
  fn: FunctionLikeNode,
  sourceFile: ts.SourceFile,
): boolean {
  // Check return type predicate
  if (fn.type?.getText(sourceFile).includes(' is ')) {
    return true
  }

  // Check function name matches predicate patterns
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    const name = fn.name.getText(sourceFile)
    // Predicate function patterns: isXxx, hasXxx, canXxx, shouldXxx
    if (/^(is|has|can|should)[A-Z]/.test(name)) {
      return true
    }
  }

  return false
}

/**
 * Check if a function is a validation/parsing function where silent returns are expected.
 * These functions legitimately return null/false for invalid input.
 */
function isValidationOrParserFunction(
  fn: FunctionLikeNode,
  sourceFile: ts.SourceFile,
): boolean {
  // Get function name if available
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    const name = fn.name.getText(sourceFile)
    // Validation/parsing function patterns: validate*, verify*, parse*, check*, extract*, get*OrNull, etc.
    if (
      // eslint-disable-next-line sonarjs/regex-complexity -- exhaustive list of known validator/parser prefixes; readable as written
      /^(validate|verify|parse|check|extract|try|attempt|find|get\w*OrNull|get|lookup|resolve|match|unregister|acquire|release|test|compare|supports)[A-Z]?/.test(
        name,
      )
    ) {
      return true
    }
  }

  // Check return type - functions returning T | null or T | undefined are validators
  if (fn.type) {
    const returnType = fn.type.getText(sourceFile)
    if (returnType.includes('| null') || returnType.includes('| undefined')) {
      return true
    }
  }

  return false
}

/**
 * Check if a return is a guard clause at the start of a function (first 3 statements).
 * Early guard clauses are a common defensive coding pattern.
 */
function isEarlyGuardClause(
  returnNode: ts.IfStatement,
  fn: FunctionLikeNode,
): boolean {
  const body = fn.body
  /* v8 ignore next -- defensive AST/type guard */
  if (!body || !ts.isBlock(body)) return false

  const statements = body.statements
  for (let i = 0; i < Math.min(statements.length, 3); i++) {
    if (statements[i] === returnNode) {
      return true
    }
  }

  return false
}

/**
 * Array predicate methods where returning false is intentional filtering
 */
const PREDICATE_METHODS = new Set([
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'map',
])

/**
 * Check if a function is a callback in an array predicate method
 * Example: arr.filter(x => { if (!x) return false; ... })
 */
function isPredicateCallback(
  fn: FunctionLikeNode,
): boolean {
  // Only arrow functions can be predicate callbacks
  if (!ts.isArrowFunction(fn)) return false

  // Check if parent is a call expression argument
  const parent = fn.parent
  /* v8 ignore next -- defensive AST/type guard */
  if (!ts.isCallExpression(parent)) return false

  // Check if the call is a method call
  const callee = parent.expression
  /* v8 ignore next -- defensive AST/type guard */
  if (!ts.isPropertyAccessExpression(callee)) return false

  // Check if method name is a predicate method
  const methodName = callee.name.getText()
  return PREDICATE_METHODS.has(methodName)
}

function extractReturnStatement(node: ts.IfStatement): ts.ReturnStatement | null {
  if (ts.isReturnStatement(node.thenStatement)) {
    return node.thenStatement
  }

  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isBlock(node.thenStatement) && node.thenStatement.statements.length === 1) {
    const statement = node.thenStatement.statements[0]
    if (statement && ts.isReturnStatement(statement)) {
      return statement
    }
  }

  return null
}

type SentinelReturnStatement = ts.ReturnStatement & { expression: ts.Expression }

function isSentinelReturn(
  returnStatement: ts.ReturnStatement | null,
): returnStatement is SentinelReturnStatement {
  return Boolean(returnStatement?.expression && SENTINEL_KINDS.has(returnStatement.expression.kind))
}

function shouldSkipForFunction(node: ts.IfStatement, sourceFile: ts.SourceFile): boolean {
  const fn = findFunction(node)
  /* v8 ignore next -- defensive AST/type guard */
  if (!fn) return false

  return (
    isTypeGuard(fn, sourceFile) ||
    isPredicateCallback(fn) ||
    isValidationOrParserFunction(fn, sourceFile) ||
    isEarlyGuardClause(node, fn)
  )
}

function hasLoggingOrMarkerInContext(node: ts.IfStatement, content: string): boolean {
  /* v8 ignore next -- defensive non-negative guard */
  const start = Math.max(0, node.getStart() - 200)
  const context = content.slice(start, node.getEnd())

  return (
    LOGGING_PATTERNS.some((p) => p.test(context)) || MARKER_PATTERNS.some((p) => p.test(context))
  )
}

function createSilentReturnViolation(
  node: ts.IfStatement,
  returnStatement: SentinelReturnStatement,
  sourceFile: ts.SourceFile,
): CheckViolation {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  /* v8 ignore next -- defensive AST/type guard */
  const val = returnStatement.expression.kind === ts.SyntaxKind.NullKeyword ? 'null' : 'false'

  return {
    line: line + 1,
    column: 0,
    message: `Silent early return (${val}) without logging`,
    severity: 'error',
    // @fitness-ignore-next-line logging-standards -- String literal in suggestion text, not actual logger call
    suggestion: `Add logging: \`if (cond) { logger.info({ evt: 'validation.failed' }); return ${val}; }\``,
    match: `return ${val}`,
  }
}

function checkSilentReturn(
  node: ts.IfStatement,
  sourceFile: ts.SourceFile,
  content: string,
): CheckViolation | null {
  const returnStatement = extractReturnStatement(node)

  if (!isSentinelReturn(returnStatement)) {
    return null
  }

  if (shouldSkipForFunction(node, sourceFile)) {
    return null
  }

  if (hasLoggingOrMarkerInContext(node, content)) {
    return null
  }

  return createSilentReturnViolation(node, returnStatement, sourceFile)
}

// =============================================================================
// CHECK IMPLEMENTATION
// =============================================================================

/**
 * Check: quality/silent-early-returns
 *
 * Detects single-line early returns (if (!x) return null/false) without logging.
 * These patterns make it impossible to know why a code path wasn't executed.
 *
 * Exceptions:
 * - Type guards (functions that return `x is T`)
 * - Boolean predicate functions (isXxx, hasXxx, canXxx, shouldXxx)
 * - Predicate callbacks (filter, find, some, every, map, etc.) where false/null means "skip item"
 * - Validation/utility functions (validate, verify, parse, check, get, test, compare, supports, etc.)
 * - Code with `// @silent-ok` marker
 * - Code with nearby logging
 * - Fitness check and framework source files (excluded from scanning)
 */
export const silentEarlyReturns = defineCheck({
  id: '9585ae15-45ea-404c-91b5-91baad7b4de0',
  slug: 'silent-early-returns',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
  description: 'Detect single-line early returns without logging',
  longDescription: `**Purpose:** Detects validation/guard paths that return sentinel values (\`null\` or \`false\`) without logging, making debugging difficult.

**Detects:** Analyzes each file individually using TypeScript AST. Finds \`if\` statements (without \`else\`) whose then-branch is a single \`return null\` or \`return false\` with no nearby logging (\`logger.\`, \`console.\`) or \`@silent-ok\` marker. Excludes type guards (\`is/has/can/should\` prefixes), predicate callbacks (\`filter\`, \`find\`, \`some\`, \`every\`, \`map\`), validation/parser/utility functions (validate, verify, parse, check, extract, try, attempt, find, get, lookup, resolve, match, unregister, acquire, release, test, compare, supports), early guard clauses (first 3 statements), and fitness check/framework source files.

**Why it matters:** Silent early returns make it impossible to diagnose why a code path was not executed, turning simple issues into hours-long debugging sessions.

**Scope:** General best practice`,
  tags: ['quality', 'observability', 'validation'],
  fileTypes: ['ts'],
  confidence: 'medium',

  analyze(content, filePath) {
    logger.debug({
      evt: 'fitness.check.silent_early_returns.analyze',
      msg: 'Analyzing file for silent early return patterns',
      filePath,
    })
    // Quick filter: must have potential silent returns
    if (!content.includes('return null') && !content.includes('return false')) {
      return []
    }

    const violations: CheckViolation[] = []

    const sourceFile = getSharedSourceFile(filePath, content)
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      // Only check if statements without else (single-line guards)
      if (ts.isIfStatement(node) && !node.elseStatement) {
        const violation = checkSilentReturn(node, sourceFile, content)
        if (violation) {
          violations.push(violation)
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return violations
  },
})
