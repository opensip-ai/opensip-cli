// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; splitting would fragment cohesive functionality
// @fitness-ignore-file fastify-schema-coverage -- Fitness check definition file; references Fastify schema patterns for detection, not actual routes
/**
 * @fileoverview Fastify Schema Coverage Check
 *
 * Validates Fastify routes have proper schema coverage:
 * - Routes without schema option (unless Zod validation is present)
 * - Routes with body but missing body schema
 * - Routes with response but missing response schema
 * - Recognizes Zod .parse()/.safeParse() on request properties as equivalent coverage
 */

import * as ts from 'typescript'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'
import { getSharedSourceFile } from '@opensip-tools/core/framework/parse-cache.js'

const BODY_METHODS = ['POST', 'PUT', 'PATCH']

interface CheckRouteSchemaOptions {
  routeText: string
  method: string
  line: number
  filePath: string
  routePath: string
}

function createSchemaViolation(
  options: CheckRouteSchemaOptions,
  type: string,
  message: string,
  suggestion: string,
): CheckViolation {
  const { method, line, filePath, routePath } = options
  return {
    filePath,
    line,
    column: 0,
    message,
    severity: 'warning',
    type,
    suggestion,
    match: `${method} ${routePath}`,
  }
}

function hasProperty(routeText: string, propertyName: string): boolean {
  return routeText.includes(`${propertyName}:`) || routeText.includes(`${propertyName} :`)
}

interface ZodValidationResult {
  hasAny: boolean
  hasBody: boolean
  hasQuery: boolean
  hasParams: boolean
  hasResponse: boolean
}

function detectZodValidation(routeText: string): ZodValidationResult {
  const bodyPattern = /\.(?:safe)?[Pp]arse\(\s{0,5}(?:request|req)\.body\s{0,5}\)/
  const queryPattern = /\.(?:safe)?[Pp]arse\(\s{0,5}(?:request|req)\.query\s{0,5}\)/
  const paramsPattern = /\.(?:safe)?[Pp]arse\(\s{0,5}(?:request|req)\.params\s{0,5}\)/
  const responsePattern = /[A-Z]\w{0,60}Schema\.parse\(/
  const generalPattern = /[A-Z]\w{0,60}Schema\.(?:safe)?[Pp]arse\(/

  const hasBody = bodyPattern.test(routeText)
  const hasQuery = queryPattern.test(routeText)
  const hasParams = paramsPattern.test(routeText)
  const hasResponse = responsePattern.test(routeText)
  const hasGeneral = generalPattern.test(routeText)

  return {
    hasAny: hasBody || hasQuery || hasParams || hasResponse || hasGeneral,
    hasBody,
    hasQuery,
    hasParams,
    hasResponse,
  }
}

function checkMissingSchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  if (hasProperty(options.routeText, 'schema')) {
    return null
  }
  if (zodResult.hasAny) {
    return null
  }
  return createSchemaViolation(
    options,
    'missing-schema',
    `Route ${options.method} ${options.routePath} has no schema option`,
    'Add schema option with body, response, params, and querystring as needed for request validation and OpenAPI documentation. Alternatively, use Zod Schema.parse() or Schema.safeParse() on request properties in the handler.',
  )
}

function handlerReadsBody(routeText: string): boolean {
  // The route's text passed in here covers the full call expression,
  // including the handler body. If neither `request.body` nor `req.body`
  // appears, the handler doesn't consume a request body — POST/PUT/PATCH
  // routes triggered purely by URL params (state-transition actions like
  // `/dispatch`, `/replay`, `/dismiss`) legitimately have no body schema
  // because there is no body. Flagging those is a false positive.
  return routeText.includes('request.body') || routeText.includes('req.body')
}

function checkMissingBodySchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  if (!BODY_METHODS.includes(options.method)) {
    return null
  }
  if (hasProperty(options.routeText, 'body')) {
    return null
  }
  if (zodResult.hasBody) {
    return null
  }
  if (!handlerReadsBody(options.routeText)) {
    return null
  }
  return createSchemaViolation(
    options,
    'missing-body-schema',
    `Route ${options.method} ${options.routePath} missing body schema`,
    'Add body schema to validate request payload. Use Zod schema from shared contract schemas.',
  )
}

function checkMissingResponseSchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  if (hasProperty(options.routeText, 'response')) {
    return null
  }
  if (zodResult.hasResponse) {
    return null
  }
  return createSchemaViolation(
    options,
    'missing-response-schema',
    `Route ${options.method} ${options.routePath} missing response schema`,
    'Add response schema for proper API documentation and type safety. Define schemas for 200, 400, 500 status codes.',
  )
}

function checkMissingParamsSchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  const hasParams = options.routePath.includes(':')
  if (!hasParams) {
    return null
  }
  if (hasProperty(options.routeText, 'params')) {
    return null
  }
  if (zodResult.hasParams) {
    return null
  }
  return createSchemaViolation(
    options,
    'missing-params-schema',
    `Route ${options.method} ${options.routePath} has path params but no params schema`,
    'Add params schema to validate path parameters. Use Zod schema to validate param types.',
  )
}

function checkMissingQuerySchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  const accessesQuery =
    options.routeText.includes('request.query') || options.routeText.includes('req.query')
  if (!accessesQuery) {
    return null
  }
  if (hasProperty(options.routeText, 'querystring')) {
    return null
  }
  if (zodResult.hasQuery) {
    return null
  }
  return createSchemaViolation(
    options,
    'missing-querystring-schema',
    `Route ${options.method} ${options.routePath} accesses query but no querystring schema`,
    'Add querystring schema to validate query parameters. Use Zod schema to validate and coerce query string values.',
  )
}

function checkRouteSchema(options: CheckRouteSchemaOptions): CheckViolation[] {
  const violations: CheckViolation[] = []

  const zodResult = detectZodValidation(options.routeText)

  const missingSchemaViolation = checkMissingSchema(options, zodResult)
  if (missingSchemaViolation) {
    violations.push(missingSchemaViolation)
    return violations
  }

  const bodyViolation = checkMissingBodySchema(options, zodResult)
  if (bodyViolation) {
    violations.push(bodyViolation)
  }

  const responseViolation = checkMissingResponseSchema(options, zodResult)
  if (responseViolation) {
    violations.push(responseViolation)
  }

  const paramsViolation = checkMissingParamsSchema(options, zodResult)
  if (paramsViolation) {
    violations.push(paramsViolation)
  }

  const queryViolation = checkMissingQuerySchema(options, zodResult)
  if (queryViolation) {
    violations.push(queryViolation)
  }

  return violations
}

function matchObjectMethod(nodeText: string): string | null {
  const match = /method\s{0,5}:\s{0,5}['"]?(GET|POST|PUT|PATCH|DELETE)['"]?/i.exec(nodeText)
  return match?.[1]?.toUpperCase() ?? null
}

function matchObjectUrl(nodeText: string): string | null {
  const match = /url\s{0,5}:\s{0,5}['"`]([^'"`]{1,200})['"`]/.exec(nodeText)
  return match?.[1] ?? null
}

function matchShorthandMethod(callText: string): string | null {
  const match = /(?:fastify|app|server)\.(get|post|put|patch|delete)\s{0,5}\(/i.exec(callText)
  return match?.[1]?.toUpperCase() ?? null
}

function matchPathArgument(callText: string): string | null {
  const match = /\(\s{0,5}['"`]([^'"`]{1,200})['"`]/.exec(callText)
  return match?.[1] ?? null
}

function analyzeObjectLiteral(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation[] {
  const nodeText = node.getText(sourceFile)
  const method = matchObjectMethod(nodeText)
  const routePath = matchObjectUrl(nodeText)

  if (!method || !routePath) {
    return []
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())

  return checkRouteSchema({
    routeText: nodeText,
    method,
    line: line + 1,
    filePath,
    routePath,
  })
}

function analyzeCallExpression(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation[] {
  const callText = node.getText(sourceFile)
  const method = matchShorthandMethod(callText)

  if (!method) {
    return []
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
  const routePath = matchPathArgument(callText) ?? ''

  return checkRouteSchema({
    routeText: callText,
    method,
    line: line + 1,
    filePath,
    routePath,
  })
}

function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  try {
    const sourceFile = getSharedSourceFile(filePath, content)
    if (!sourceFile) return []

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        violations.push(...analyzeObjectLiteral(node, sourceFile, filePath))
      } else if (ts.isCallExpression(node)) {
        violations.push(...analyzeCallExpression(node, sourceFile, filePath))
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations
}

function isRouteFile(file: string): boolean {
  const hasRouteKeyword =
    file.includes('route') || file.includes('controller') || file.includes('endpoint')
  const isTestFile = file.includes('.test.') || file.includes('.spec.')
  const isTypeFile = file.endsWith('.d.ts')
  return hasRouteKeyword && !isTestFile && !isTypeFile
}

export const fastifySchemaCoverage = defineCheck({
  id: '16f14276-7a70-43bb-8097-181dd277371c',
  slug: 'fastify-schema-coverage',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'code-only',

  confidence: 'high',
  description: 'Validate that Fastify routes have proper request/response schema validation',
  longDescription: `**Purpose:** Validates that Fastify route definitions include complete schema options for request and response validation.

**Detects:**
- Routes (both object-literal \`{ method: 'POST', url: '...' }\` and shorthand \`fastify.post(...)\` styles) missing the \`schema\` option entirely
- POST/PUT/PATCH routes missing a \`body:\` schema property when the handler reads \`request.body\` (state-transition routes triggered by URL params with no body access are not flagged)
- Routes missing a \`response:\` schema property
- Routes with path parameters (containing \`:\`) missing a \`params:\` schema property
- Routes accessing \`request.query\`/\`req.query\` missing a \`querystring:\` schema property

**Zod validation support:** Routes using Zod-based validation in the handler body are recognized as having equivalent schema coverage:
- \`Schema.safeParse(request.body)\` / \`Schema.parse(request.body)\` — counts as body validation
- \`Schema.safeParse(request.query)\` / \`Schema.parse(request.query)\` — counts as querystring validation
- \`Schema.safeParse(request.params)\` / \`Schema.parse(request.params)\` — counts as params validation
- \`Schema.parse(result)\` (any \`*Schema.parse()\` call) — counts as response validation

**Why it matters:** Missing schema properties disable Fastify's built-in request validation and omit routes from OpenAPI documentation, leading to undocumented and unvalidated endpoints.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing. Only processes route/controller/endpoint files.`,
  tags: ['quality', 'code-quality', 'best-practices', 'security', 'fastify', 'schema'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    if (!isRouteFile(filePath)) {
      return []
    }

    if (!content.includes('fastify') && !content.includes('route')) {
      return []
    }

    return analyzeFile(content, filePath)
  },
})
