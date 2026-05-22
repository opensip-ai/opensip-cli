// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
/**
 * @fileoverview OpenAPI Response Coverage Check
 *
 * Validates OpenAPI response schemas coverage:
 * - Routes should have error response schemas (400, 401, 404, 500)
 * - Missing response schemas cause client-side type errors
 * - Ensures consistent error response formats
 */


import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'
import { getSharedSourceFile } from '@opensip-tools/lang-typescript'
import * as ts from 'typescript'

/**
 * Issue types for OpenAPI response coverage
 */
type ResponseCoverageIssueType =
  | 'missing-error-responses'
  | 'missing-400'
  | 'missing-401'
  | 'missing-404'
  | 'missing-500'

/**
 * Required error status codes for different route types
 */
const REQUIRED_ERROR_CODES: Record<string, number[]> = {
  POST: [400, 401, 500],
  PUT: [400, 401, 404, 500],
  PATCH: [400, 401, 404, 500],
  DELETE: [401, 404, 500],
  GET: [401, 404, 500],
}

// Pre-compiled regex patterns to avoid runtime regex construction issues
// These are safe patterns with bounded quantifiers to prevent ReDoS
const RESPONSE_BLOCK_PATTERN = /response\s{0,10}:\s{0,10}\{/
const STATUS_CODE_PATTERN = /[1-5]\d{2}\s{0,5}:/g
const METHOD_PATTERN = /method\s{0,5}:\s{0,5}['"]?(GET|POST|PUT|PATCH|DELETE)['"]?/i
const SCHEMA_PATTERN = /schema\s{0,5}:\s{0,5}\{/
const URL_PATTERN = /url\s{0,5}:\s{0,5}['"`]([^'"`]{1,200})['"`]/
const FASTIFY_METHOD_PATTERN = /fastify\.(get|post|put|patch|delete)\s{0,5}\(/i
const FASTIFY_PATH_PATTERN = /\(\s{0,5}['"`]([^'"`]{1,200})['"`]/

/**
 * Maps a status code to its issue type
 * @param code - The HTTP status code
 * @returns The corresponding issue type
 */
function codeToIssueType(code: number): ResponseCoverageIssueType {
  const codeMap: Record<number, ResponseCoverageIssueType> = {
    400: 'missing-400',
    401: 'missing-401',
    404: 'missing-404',
    500: 'missing-500',
  }
  /* v8 ignore next -- defensive AST/type guard */
  return codeMap[code] ?? 'missing-error-responses'
}

/**
 * Extracts status codes defined in a response block
 * @param text - The text to search for status codes
 * @returns Set of defined status codes
 */
function extractDefinedStatusCodes(text: string): Set<number> {
  const definedCodes = new Set<number>()
  const codeMatches = text.matchAll(STATUS_CODE_PATTERN)
  for (const match of codeMatches) {
    const codeStr = match[0].replace(':', '').trim()
    // @fitness-ignore-next-line numeric-validation -- regex [1-5]\d{2} guarantees valid 3-digit status code; range check follows
    const code = Number.parseInt(codeStr, 10)
    if (code >= 100 && code <= 599) {
      definedCodes.add(code)
    }
  }
  return definedCodes
}

/**
 * Check response coverage for a route
 * @param schemaText - The schema text to analyze
 * @param method - The HTTP method
 * @returns Array of issues found
 */
function checkResponseCoverage(
  schemaText: string,
  method: string,
): { type: ResponseCoverageIssueType; code: number; severity: 'error' | 'warning' }[] {
  const requiredCodes = REQUIRED_ERROR_CODES[method] ?? [401, 500]

  // Check if response block exists using pre-compiled pattern
  if (!RESPONSE_BLOCK_PATTERN.test(schemaText)) {
    return requiredCodes.map((code) => ({
      type: 'missing-error-responses',
      code,
      severity: 'warning' as const,
    }))
  }

  const definedCodes = extractDefinedStatusCodes(schemaText)
  const missingCodes = requiredCodes.filter((code) => !definedCodes.has(code))

  return missingCodes.map((code) => ({
    type: codeToIssueType(code),
    code,
    severity: code === 500 ? 'error' : 'warning',
  }))
}

interface RouteIssue {
  line: number
  message: string
  severity: 'error' | 'warning'
  type: ResponseCoverageIssueType
}

interface AnalysisResult {
  issues: RouteIssue[]
  routes: number
}

/**
 * Options for processing route issues
 */
interface ProcessRouteIssuesOptions {
  coverageIssues: { type: ResponseCoverageIssueType; code: number; severity: 'error' | 'warning' }[]
  method: string
  routePath: string | undefined
  line: number
  issues: RouteIssue[]
}

/**
 * Process coverage issues and add them to the issues array
 * @param options - The options for processing route issues
 */
function processRouteIssues(options: ProcessRouteIssuesOptions): void {
  const { coverageIssues, method, routePath, line, issues } = options
  // Validate array parameters
  /* v8 ignore next -- defensive guard */
  if (!Array.isArray(coverageIssues) || !Array.isArray(issues)) {
    return
  }

  for (const issue of coverageIssues) {
    issues.push({
      line,
      /* v8 ignore next -- defensive nullish fallback */
      message: `Route ${method} ${routePath ?? ''} missing ${issue.code} response schema`,
      severity: issue.severity,
      type: issue.type,
    })
  }
}

/**
 * Analyze an object literal for route definitions
 * @param node - The object literal node
 * @param sourceFile - The source file
 * @param issues - The issues array to add to
 * @returns True if a route was found
 */
function analyzeObjectLiteral(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  issues: RouteIssue[],
): boolean {
  const nodeText = node.getText(sourceFile)
  const methodMatch = METHOD_PATTERN.exec(nodeText)
  const schemaMatch = SCHEMA_PATTERN.test(nodeText)

  // @fitness-ignore-next-line silent-early-returns -- Guard clause: node without method or schema is not a Fastify route
  if (!methodMatch || !schemaMatch) {
    return false
  }

  const method = methodMatch[1]?.toUpperCase() ?? 'GET'
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const pathMatch = URL_PATTERN.exec(nodeText)
  const routePath = pathMatch?.[1]
  const coverageIssues = checkResponseCoverage(nodeText, method)
  processRouteIssues({ coverageIssues, method, routePath, line: line + 1, issues })
  return true
}

/**
 * Analyze a call expression for Fastify route shorthand methods
 * @param node - The call expression node
 * @param sourceFile - The source file
 * @param issues - The issues array to add to
 * @returns True if a route was found
 */
function analyzeCallExpression(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  issues: RouteIssue[],
): boolean {
  const callText = node.getText(sourceFile)
  const methodMatch = FASTIFY_METHOD_PATTERN.exec(callText)

  if (!methodMatch || !callText.includes('schema')) {
    return false
  }

  const method = methodMatch[1]?.toUpperCase() ?? 'GET'
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const pathMatch = FASTIFY_PATH_PATTERN.exec(callText)
  const routePath = pathMatch?.[1]
  const coverageIssues = checkResponseCoverage(callText, method)
  processRouteIssues({ coverageIssues, method, routePath, line: line + 1, issues })
  return true
}

/**
 * Analyze a file for response coverage
 * @param sourceFile - The TypeScript source file
 * @returns Analysis result with issues and route count
 */
function analyzeSourceFile(sourceFile: ts.SourceFile): AnalysisResult {
  const issues: RouteIssue[] = []
  let routes = 0

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && analyzeObjectLiteral(node, sourceFile, issues)) {
      routes++
    }

    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isCallExpression(node) && analyzeCallExpression(node, sourceFile, issues)) {
      routes++
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { issues, routes }
}

/**
 * Check if file is a route file
 */
function isRouteFile(file: string): boolean {
  return (
    file.includes('route') ||
    file.includes('controller') ||
    file.includes('endpoint') ||
    file.includes('handler')
  )
}

/**
 * Check: quality/openapi-response-coverage
 *
 * Validates that API routes have proper error response schemas in OpenAPI spec.
 */
export const openapiResponseCoverage = defineCheck({
  id: 'b2560fbb-6657-4ae7-9a0b-1c785ee3ef3f',
  slug: 'openapi-response-coverage',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Validates that API routes have proper error response schemas in OpenAPI spec',
  longDescription: `**Purpose:** Validates that Fastify route schemas include error response definitions for all required HTTP status codes.

**Detects:**
- Routes missing a \`response:\` block entirely
- Per-method missing status codes: POST requires 400/401/500, PUT/PATCH require 400/401/404/500, DELETE requires 401/404/500, GET requires 401/404/500
- Status codes extracted via \`/[1-5]\\d{2}\\s{0,5}:/g\` and compared against the required set for each HTTP method

**Why it matters:** Missing error response schemas cause client-side type errors and produce incomplete OpenAPI documentation, leaving consumers unable to handle error cases correctly.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing. Only processes route/controller/endpoint/handler files.`,
  tags: ['openapi', 'api', 'quality'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180_000, // 3 minutes - scans route files and OpenAPI specs

  analyze(content, filePath) {
    // Focus on route files
    if (!isRouteFile(filePath)) {
      return []
    }

    // Quick check: skip files without route patterns
    if (!content.includes('schema') && !content.includes('response')) {
      return []
    }

    try {
      const sourceFile = getSharedSourceFile(filePath, content)
      /* v8 ignore next -- defensive guard */
      if (!sourceFile) return []

      const { issues } = analyzeSourceFile(sourceFile)
      const violations: CheckViolation[] = []

      for (const issue of issues) {
        const lines = content.split('\n')
        /* v8 ignore next -- defensive nullish fallback */
        const matchText = lines[issue.line - 1] ?? ''

        violations.push({
          filePath,
          line: issue.line,
          column: 0,
          message: issue.message,
          severity: issue.severity,
          suggestion: `Add a ${issue.type.replace('missing-', '')} response schema to the route definition with appropriate error type`,
          match: matchText,
        })
      }

      return violations
    /* v8 ignore next 1 -- defensive catch: parse failures already handled */
    } catch {
      // @swallow-ok Skip unreadable files
      return []
    }
  },
})
