// @fitness-ignore-file no-generic-error -- Generic errors appropriate in this context
// @fitness-ignore-file file-length-limit -- JSDoc documentation required for public API
// @fitness-ignore-file no-hardcoded-timeouts -- framework default for fitness check execution timeout
/**
 * @fileoverview Missing @throws JSDoc Detection Check
 *
 * Detects functions that contain throw statements but lack @throws JSDoc documentation.
 *
 */


import { defineCheck, getCheckConfig, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Recipe-config shape for throws-documentation. Project-specific typed-error
 * suffixes (e.g. opensip's `CompositionError`, `CanonicalizationError`)
 * belong in a recipe's `checks.config['throws-documentation']` block, not
 * in built-in defaults.
 */
export interface ThrowsDocConfig extends Record<string, unknown> {
  /** Class-name suffixes that mark a thrown error as self-documenting. */
  additionalSelfDocumentingSuffixes?: readonly string[]
}

// =============================================================================
// TYPES
// =============================================================================

/** Function-like node types that can have throw statements */
type FunctionLikeNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction

/** Context for analyzing a single file */
interface FileAnalysisContext {
  sourceFile: ts.SourceFile
  content: string
  filePath: string
  /** Effective self-documenting suffix list (built-in + recipe config). */
  selfDocumentingSuffixes: readonly string[]
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if node is a function-like node (function, method, or arrow function)
 * @param n - The TypeScript AST node to check
 * @returns True if the node is a function declaration, function expression, arrow function, or method declaration
 */
function isFunctionLikeNode(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  )
}

/**
 * Find throw statements in a node (not descending into nested functions)
 * @param node - The AST node to search for throw statements
 * @returns Array of throw statements found in the node (excluding nested functions)
 */
function findThrowStatements(node: ts.Node): ts.ThrowStatement[] {
  const throws: ts.ThrowStatement[] = []

  const visit = (n: ts.Node): void => {
    // Don't descend into nested functions
    if (isFunctionLikeNode(n) && n !== node) {
      return
    }
    if (ts.isThrowStatement(n)) {
      throws.push(n)
    }
    ts.forEachChild(n, visit)
  }

  visit(node)
  return throws
}

/**
 * Check if a node has @throws JSDoc
 * @param node - The AST node to check for @throws documentation
 * @param sourceFile - The source file containing the node
 * @returns True if the node has a @throws JSDoc comment
 */
function hasThrowsJSDoc(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const fullText = sourceFile.getFullText()
  const nodeStart = node.getFullStart()
  const comments = ts.getLeadingCommentRanges(fullText, nodeStart)

  if (!comments) return false

  for (const comment of comments) {
    const commentText = fullText.slice(comment.pos, comment.end)
    if (commentText.includes('@throws')) {
      return true
    }
  }
  return false
}

const ANONYMOUS_FUNCTION_NAME = '<anonymous>'

/**
 * Get function name from a function declaration node
 * @param node - The function declaration node
 * @returns The function name, or "<anonymous>" if unnamed
 */
function getNameFromFunctionDeclaration(node: ts.FunctionDeclaration): string {
  return node.name?.text ?? ANONYMOUS_FUNCTION_NAME
}

/**
 * Get function name from a method declaration node
 * @param node - The method declaration node
 * @returns The method name, or "<anonymous>" if the name is not an identifier
 */
function getNameFromMethodDeclaration(node: ts.MethodDeclaration): string {
  return ts.isIdentifier(node.name) ? node.name.text : ANONYMOUS_FUNCTION_NAME
}

/**
 * Get function name from an arrow function node
 * @param node - The arrow function node
 * @returns The variable name if assigned to a variable, or "<anonymous>" otherwise
 */
function getNameFromArrowFunction(node: ts.ArrowFunction): string {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  return ANONYMOUS_FUNCTION_NAME
}

/**
 * Get the name of a function-like node
 * @param node - The function-like node (function declaration, method, or arrow function)
 * @returns The function name, or "<anonymous>" if unnamed
 */
// @fitness-ignore-next-line duplicate-utility-functions -- Check-specific helper for FunctionLikeNode; each fitness check defines its own variant for its node type
function getFunctionName(node: FunctionLikeNode): string {
  if (ts.isFunctionDeclaration(node)) {
    return getNameFromFunctionDeclaration(node)
  }
  if (ts.isMethodDeclaration(node)) {
    return getNameFromMethodDeclaration(node)
  }
  return getNameFromArrowFunction(node)
}

/**
 * Check if an arrow function is an anonymous callback that should be skipped
 * @param node - The arrow function node to check
 * @returns True if the arrow function is used as a callback in a call expression
 */
function isAnonymousCallback(node: ts.ArrowFunction): boolean {
  const parent = node.parent
  return ts.isCallExpression(parent) || ts.isCallExpression(parent.parent)
}

/**
 * Typed error classes (e.g., from a project error module).
 * These are self-documenting and don't require @throws JSDoc.
 */
const SELF_DOCUMENTING_ERRORS = new Set([
  // Domain errors
  'ValidationError',
  'AuthorizationError',
  'NotFoundError',
  'ConflictError',
  'DomainError',
  // System errors
  'SystemError',
  'ConfigurationError',
  'InfrastructureError',
  'ExternalServiceError',
  'DatabaseError',
  'CacheError',
  'NetworkError',
  // Application errors
  'ApplicationError',
  'OperationError',
  'StateError',
  'IntegrationError',
  // HTTP errors
  'BadRequestError',
  'UnauthorizedError',
  'ForbiddenError',
  'MethodNotAllowedError',
  'NotAcceptableError',
  'RequestTimeoutError',
  'GoneError',
  'PayloadTooLargeError',
  'UnsupportedMediaTypeError',
  'UnprocessableEntityError',
  'TooManyRequestsError',
  'InternalServerError',
  'NotImplementedError',
  'BadGatewayError',
  'ServiceUnavailableError',
  'GatewayTimeoutError',
  // Common error aliases
  'InputValidationError',
  'BusinessRuleError',
  'AuthenticationError',
  'PermissionError',
  'ResourceNotFoundError',
  'DuplicateResourceError',
  'DataIntegrityError',
])

/**
 * Suffixes that indicate a self-documenting error type.
 * These typed error classes are descriptive enough that @throws JSDoc adds little value.
 *
 * The list is intentionally broad: any class name ending in a recognizable error
 * suffix counts as self-documenting because it carries its semantic meaning in the
 * type name itself (callers can read and handle the typed error directly without
 * needing prose).
 */
const SELF_DOCUMENTING_SUFFIXES = [
  'ValidationError',
  'NotFoundError',
  'AuthorizationError',
  'SystemError',
  'DomainError',
  'ConfigurationError',
  'SecurityError',
  'TimeoutError',
  'LockError',
  'LimitError',
  'InfrastructureError',
  'ApplicationError',
  'OperationError',
  'ErrorBuilder', // Builder pattern for typed errors
  // Generic-sounding suffixes any project may use:
  'NetworkError',
  'ExecutionError',
  'LoadError',
  'VerifyError',
  'ApiError',
  'ParseError',
  'EncodingError',
  'DecodingError',
  'StateError',
  'SyncError',
  'CaptureError',
  'IntegrationError',
  'PermissionError',
  'AccessError',
  'AuthenticationError',
  'ResourceNotFoundError',
  'DuplicateResourceError',
  'DataIntegrityError',
  'BusinessRuleError',
  'InputValidationError',
  // NOTE: opensip-specific suffixes — `CompositionError`, `CompositeError`,
  // `CanonicalizationError`, `TransformError`, `VersioningError`,
  // `TransitionError` — are NOT defaults. They live in opensip's recipe
  // under `checks.config['throws-documentation'].additionalSelfDocumentingSuffixes`.
]

/**
 * Build the effective self-documenting suffix list by merging built-in
 * defaults with the recipe config slice. Called per-file from the analyze entry.
 */
function buildEffectiveSuffixes(): readonly string[] {
  const cfg = getCheckConfig<ThrowsDocConfig>('throws-documentation')
  return [...SELF_DOCUMENTING_SUFFIXES, ...(cfg.additionalSelfDocumentingSuffixes ?? [])]
}

function isSelfDocumentingError(errorType: string, suffixes: readonly string[]): boolean {
  // Check exact match
  if (SELF_DOCUMENTING_ERRORS.has(errorType)) {
    return true
  }
  // Check if it ends with known self-documenting patterns
  return suffixes.some((suffix) => errorType.endsWith(suffix))
}

/**
 * Extract thrown error type from a throw statement
 * @param throwStmt - The throw statement to analyze
 * @param sourceFile - The source file containing the throw statement
 * @returns The error class name (e.g., "TypeError"), or "Error" if not determinable
 */
function extractThrownType(throwStmt: ts.ThrowStatement, sourceFile: ts.SourceFile): string {
  const text = throwStmt.expression.getText(sourceFile)
  // @fitness-ignore-next-line sonarjs-backend -- Safe regex with fixed tokens for extracting error class name
  const typeMatch = /new\s+(\w+)/.exec(text)
  return typeMatch?.[1] ?? 'Error'
}

/**
 * Get unique thrown error types from throw statements
 * @param throwStatements - Array of throw statements to analyze
 * @param sourceFile - The source file containing the throw statements
 * @returns Array of unique error type names found in the throw statements
 */
function getUniqueThrowTypes(
  throwStatements: ts.ThrowStatement[],
  sourceFile: ts.SourceFile,
): string[] {
  if (!Array.isArray(throwStatements)) {
    return []
  }
  const thrownTypes = throwStatements.map((t) => extractThrownType(t, sourceFile))
  return [...new Set(thrownTypes)]
}

/**
 * Create a violation for a function missing @throws documentation
 * @param node - The function-like node that is missing @throws documentation
 * @param funcName - The name of the function
 * @param throwStatements - The throw statements found in the function
 * @param ctx - The file analysis context
 * @returns A violation object describing the missing @throws documentation
 * @throws {Error} If throwStatements is not an array
 */
function createMissingThrowsViolation(
  node: FunctionLikeNode,
  funcName: string,
  throwStatements: ts.ThrowStatement[],
  ctx: FileAnalysisContext,
): CheckViolation {
  if (!Array.isArray(throwStatements)) {
    throw new TypeError('throwStatements must be an array')
  }
  const { line, character } = ctx.sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const lineNum = line + 1
  const uniqueTypes = getUniqueThrowTypes(throwStatements, ctx.sourceFile)

  return {
    line: lineNum,
    column: character + 1,
    message: `Function '${funcName}' throws but lacks @throws JSDoc`,
    severity: 'warning',
    suggestion: `Add @throws JSDoc above the function: /** @throws {${uniqueTypes.join(' | ')}} Description of when this error is thrown */`,
    match: funcName,
  }
}

/**
 * Check if a function-like node should be analyzed
 * @param node - The function-like node to check
 * @param funcName - The name of the function
 * @returns True if the function should be analyzed for @throws documentation
 */
function shouldAnalyzeFunction(node: FunctionLikeNode, funcName: string): boolean {
  // Skip anonymous arrow function callbacks
  if (funcName === '<anonymous>' && ts.isArrowFunction(node)) {
    return !isAnonymousCallback(node)
  }
  return true
}

/**
 * Check if all throw statements in a function use self-documenting errors
 * @param throwStatements - Array of throw statements to check
 * @param sourceFile - The source file containing the throw statements
 * @returns True if all thrown errors are self-documenting
 */
function allThrowsSelfDocumenting(
  throwStatements: ts.ThrowStatement[],
  sourceFile: ts.SourceFile,
  suffixes: readonly string[],
): boolean {
  if (!Array.isArray(throwStatements) || throwStatements.length === 0) {
    return false
  }
  return throwStatements.every((stmt) => {
    const errorType = extractThrownType(stmt, sourceFile)
    return isSelfDocumentingError(errorType, suffixes)
  })
}

/**
 * Common error-field name patterns on `this` that indicate a stored-error rethrow.
 * Used to recognise patterns like `throw this.error` (Result-pattern Failure rethrow).
 */
const ERROR_FIELD_NAME_PATTERN = /^(error|err|cause|innerError|originalError)$/i

/**
 * Generic error-variable name patterns (caught-error identifiers).
 * Used as a fallback when we cannot statically determine the enclosing catch clause
 * (e.g. when isRethrow is called without a function context).
 */
const ERROR_VAR_NAME_PATTERN = /^(error|err|e|ex|exception)$/i

/**
 * Collect identifier names introduced by `catch (X)` clauses anywhere inside the
 * given function-like node (excluding nested function bodies). These names are the
 * caught-error variables that a subsequent `throw <name>` or `throw <name>.<...>`
 * is treated as a re-throw of.
 *
 * @param fnNode - The enclosing function-like node
 * @returns Set of caught-error variable names
 */
function collectCaughtErrorNames(fnNode: ts.Node): Set<string> {
  const names = new Set<string>()
  const visit = (n: ts.Node): void => {
    // Don't descend into nested function bodies — their catch variables are
    // out of scope at the throw site we care about.
    if (isFunctionLikeNode(n) && n !== fnNode) {
      return
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      const decl = n.variableDeclaration
      if (ts.isIdentifier(decl.name)) {
        names.add(decl.name.text)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(fnNode)
  return names
}

/**
 * Check if a throw statement is a re-throw of a caught error.
 *
 * Recognised re-throw shapes:
 *  - `throw err`                     — bare caught-error identifier
 *  - `throw err.unwrapErr()`         — typed Result rethrow
 *  - `throw this.error`              — Result-pattern Failure stored-error rethrow
 *  - `throw sanitizedError(err)`     — single-arg helper wrapping a caught error
 *
 * @param throwStmt - The throw statement to check
 * @param sourceFile - The source file containing the throw statement
 * @param caughtNames - Names of caught-error variables in the enclosing function
 * @returns True if this throw statement re-throws (rather than freshly creates) an error
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- rethrow heuristic: enumerates the AST shapes that count as rethrowing (caught var, wrapping cause, scoped helpers); flatter shape would obscure the matching logic
function isRethrow(
  throwStmt: ts.ThrowStatement,
  sourceFile: ts.SourceFile,
  caughtNames?: Set<string>,
): boolean {
  const expr = throwStmt.expression
  const text = expr.getText(sourceFile).trim()

  // `new X(...)` is never a re-throw.
  if (ts.isNewExpression(expr)) return false

  // `throw err` — bare identifier
  if (ts.isIdentifier(expr)) {
    if (caughtNames?.has(expr.text)) return true
    // Fallback: name matches a generic caught-error pattern (used when no context).
    return ERROR_VAR_NAME_PATTERN.test(expr.text)
  }

  // `throw this.error` / `throw this.cause` — stored-error field rethrow
  if (ts.isPropertyAccessExpression(expr) && 
      expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(expr.name) &&
      ERROR_FIELD_NAME_PATTERN.test(expr.name.text)
    ) {
      return true
    }

  // Result-pattern rethrows: `throw X.unwrapErr()` / `throw X.unwrap()` —
  // the throw extracts an already-typed error from a Result and propagates it.
  // We treat this as a rethrow regardless of whether X is in scope as a caught
  // variable, because the wrapped error is itself a typed error from elsewhere.
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const methodName = ts.isIdentifier(expr.expression.name) ? expr.expression.name.text : ''
    if (methodName === 'unwrapErr' || methodName === 'unwrap') {
      return true
    }
    // Method invocation on a caught-error variable — also a rethrow.
    const root = expr.expression.expression
    if (ts.isIdentifier(root) && caughtNames?.has(root.text)) {
      return true
    }
  }

  // `throw sanitizedError(err)` — single-arg call wrapping a caught-error variable.
  // Heuristic: the call has exactly one argument and that argument is an identifier
  // matching a caught-error name (preferred) or the generic err/error pattern.
  if (ts.isCallExpression(expr) && expr.arguments.length === 1) {
    const arg = expr.arguments[0]
    if (arg && ts.isIdentifier(arg)) {
      if (caughtNames?.has(arg.text)) return true
      if (!caughtNames && ERROR_VAR_NAME_PATTERN.test(arg.text)) return true
    }
  }

  // Legacy fallback: bare-identifier-shaped text without 'new'. Kept for backward
  // compatibility with call sites that don't pass the AST node.
  return !text.includes('new ') && ERROR_VAR_NAME_PATTERN.test(text)
}

/**
 * Analyze a function-like node for missing @throws documentation
 * @param node - The function-like node to analyze
 * @param ctx - The file analysis context
 * @returns A violation if the function is missing @throws documentation, or null if compliant
 */
function analyzeFunctionNode(
  node: FunctionLikeNode,
  ctx: FileAnalysisContext,
): CheckViolation | null {
  const funcName = getFunctionName(node)

  if (!shouldAnalyzeFunction(node, funcName)) {
    return null
  }

  const throwStatements = findThrowStatements(node)

  if (throwStatements.length === 0) {
    return null
  }

  // Skip if already has @throws documentation
  if (hasThrowsJSDoc(node, ctx.sourceFile)) {
    return null
  }

  // Skip if all throws are self-documenting typed errors
  if (allThrowsSelfDocumenting(throwStatements, ctx.sourceFile, ctx.selfDocumentingSuffixes)) {
    return null
  }

  // Skip if all throws are re-throws (error propagation). We pass the set of
  // caught-error variable names declared in any `catch (X)` clause inside the
  // function so that `throw err`, `throw err.unwrapErr()`, and
  // `throw sanitizedError(err)` are recognised as rethrows.
  const caughtNames = collectCaughtErrorNames(node)
  if (throwStatements.every((stmt) => isRethrow(stmt, ctx.sourceFile, caughtNames))) {
    return null
  }

  return createMissingThrowsViolation(node, funcName, throwStatements, ctx)
}

/**
 * Analyze a file for missing @throws documentation
 * @param ctx - The file analysis context containing source file and metadata
 * @returns Array of violations for functions missing @throws documentation
 */
function analyzeFile(ctx: FileAnalysisContext): CheckViolation[] {
  const violations: CheckViolation[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)
    ) {
      const violation = analyzeFunctionNode(node, ctx)
      if (violation) {
        violations.push(violation)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(ctx.sourceFile)
  return violations
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/throws-documentation
 *
 * Detects functions with throw statements but no @throws JSDoc.
 */
export const throwsDocumentation = defineCheck({
  id: 'f4fb7ff5-5927-4b0b-a9cf-d919cd37c931',
  slug: 'throws-documentation',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detects functions with throw statements but no @throws JSDoc',
  longDescription: `**Purpose:** Detects functions that contain \`throw\` statements but lack \`@throws\` JSDoc documentation, ensuring callers know what errors to expect.

**Detects:** Analyzes each file individually using TypeScript AST. Finds function/method/arrow-function declarations with throw statements that have no leading \`@throws\` JSDoc comment. Skips anonymous callbacks, re-throws (\`throw err\`), and self-documenting typed error classes (e.g. \`ValidationError\`, \`NotFoundError\`, and other project error classes).

**Why it matters:** Without \`@throws\` documentation, callers cannot know which errors to handle, leading to unhandled exceptions in production.

**Scope:** Codebase-specific convention enforcing error handling standards`,
  tags: ['quality', 'documentation', 'best-practices'],
  fileTypes: ['ts'],
  timeout: 180_000, // 3 minutes - parses TypeScript AST for all backend files

  analyze(content, filePath) {
    // Quick filter
    if (!content.includes('throw ')) {
      return []
    }

    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    return analyzeFile({
      sourceFile,
      content,
      filePath,
      selfDocumentingSuffixes: buildEffectiveSuffixes(),
    })
  },
})
