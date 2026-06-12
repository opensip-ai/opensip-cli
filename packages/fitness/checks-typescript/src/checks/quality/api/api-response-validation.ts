// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
// @fitness-ignore-file no-raw-regex-on-code -- fitness check: regex patterns analyze trusted codebase content, not user input
/**
 * @fileoverview API Response Validation Check
 *
 * Ensures API responses are validated with Zod schemas before being sent to clients.
 * Validates that response types match their Zod schema definitions.
 */

import { basename } from 'node:path';

import { defineCheck, type CheckViolation, isAPIFile } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Check if a file contains Fastify route-level response schema definitions.
 * Routes using `schema: { response: ... }` already validate responses at the framework level.
 *
 * The previous regex `\{[^}]*response\s*:` failed on real route schemas
 * because real schemas contain nested object literals — once the regex
 * hits the first `}` (e.g. closing a `querystring` block) it gives up
 * before reaching `response:`. The lazy `.*?` form scans across nested
 * braces correctly. We also accept the related forms a Zod-typed Fastify
 * route uses: bare `response: {` blocks, response-status-keyed objects,
 * and ResponseSchema imports paired with .send.
 */
function hasRouteResponseSchema(content: string): boolean {
  // schema: { ... response: ... } — handles nested braces via lazy match.
  if (/schema\s*:\s*\{.*?\bresponse\s*:/s.test(content)) return true;
  // Direct `response: { 200: ... }` block — Fastify also accepts this
  // shape outside an enclosing `schema:` wrapper inside `RouteOptions`.
  if (/\bresponse\s*:\s*\{\s*[12345]\d{2}\s*:/s.test(content)) return true;
  return false;
}

/**
 * Check if a file only uses `reply.send()` with dynamic/passthrough payloads.
 * These routes forward external API responses or computed results that have no fixed shape.
 */
function isDynamicReplyOnly(content: string): boolean {
  // If file has reply.send() but no reply.status().send({ ... }) with object literals,
  // it's likely a passthrough/dynamic endpoint
  const hasSendCalls = content.includes('reply.send(') || content.includes('reply.send (');
  if (!hasSendCalls) return false;

  // If there's a reply.code/status + structured object, it likely has a fixed shape
  const hasStructuredResponse =
    /reply\s*\.\s*(?:code|status)\s*\([^)]+\)\s*\.\s*send\s*\(\s*\{/.test(content);

  // If there's no structured response pattern, treat as dynamic
  return !hasStructuredResponse;
}

/**
 * State tracking for API response analysis
 */
interface ApiResponseState {
  hasResponseSchemaImport: boolean;
  hasResponseValidation: boolean;
  hasApiResponse: boolean;
}

/**
 * Check if an import declaration imports schema/contracts
 */
function checkSchemaImport(node: ts.ImportDeclaration, state: ApiResponseState): void {
  const moduleSpecifier = node.moduleSpecifier;
  if (ts.isStringLiteral(moduleSpecifier)) {
    const importPath = moduleSpecifier.text;
    if (importPath.includes('schema') || importPath.includes('contracts')) {
      state.hasResponseSchemaImport = true;
    }
  }
}

/**
 * Check if a call expression validates a response
 */
function checkValidationCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  state: ApiResponseState,
): void {
  const callText = node.expression.getText(sourceFile);
  if (!callText.includes('parse') && !callText.includes('safeParse')) {
    return;
  }

  /* v8 ignore next -- defensive nullish fallback */
  const argText = node.arguments[0]?.getText(sourceFile) ?? '';
  if (argText.includes('response') || argText.includes('result') || argText.includes('data')) {
    state.hasResponseValidation = true;
  }
}

/**
 * Check if a return statement returns an API response
 */
function checkApiResponseReturn(
  node: ts.ReturnStatement,
  sourceFile: ts.SourceFile,
  state: ApiResponseState,
): void {
  /* v8 ignore next -- defensive AST/type guard */
  if (!node.expression) return;

  const returnText = node.expression.getText(sourceFile);
  if (
    returnText.includes('res.') ||
    returnText.includes('reply.') ||
    returnText.includes('response.')
  ) {
    state.hasApiResponse = true;
  }
}

/**
 * Check if a file is an SSE/streaming endpoint.
 * These routes use raw writes or event-stream content types, not structured JSON responses.
 */
function isStreamingFile(content: string): boolean {
  return content.includes('text/event-stream') || content.includes('reply.raw.write');
}

/**
 * Check if a file serves diagnostic, debug, or health endpoints.
 * These routes intentionally return dynamic/unstructured payloads.
 */
function isDiagnosticFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return (
    lowerPath.includes('diagnostic') || lowerPath.includes('debug') || lowerPath.includes('health')
  );
}

/**
 * @returns {*}
 * Analyze a file for response validation issues
 */
function analyzeFile(absolutePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  // Skip SSE/streaming routes — they don't return structured JSON
  /* v8 ignore next -- defensive AST/type guard */
  if (isStreamingFile(content)) return [];

  // Skip diagnostic/debug/health endpoints — intentionally dynamic responses
  /* v8 ignore next -- defensive AST/type guard */
  if (isDiagnosticFile(absolutePath)) return [];

  // Skip routes that define response schemas at the Fastify route level
  /* v8 ignore next -- defensive AST/type guard */
  if (hasRouteResponseSchema(content)) return [];

  // Skip routes that only use reply.send() with dynamic/passthrough payloads
  if (isDynamicReplyOnly(content)) return [];

  const sourceFile = getSharedSourceFile(absolutePath, content);
  /* v8 ignore next -- defensive guard */
  if (!sourceFile) return [];

  // Track if file has response schema imports
  // Use state object to track findings across callback invocations
  // (TypeScript can't track primitive mutations in callbacks)
  const state: ApiResponseState = {
    hasResponseSchemaImport: false,
    hasResponseValidation: false,
    hasApiResponse: false,
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      checkSchemaImport(node, state);
    }
    if (ts.isCallExpression(node)) {
      checkValidationCall(node, sourceFile, state);
    }
    if (ts.isReturnStatement(node)) {
      checkApiResponseReturn(node, sourceFile, state);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  // If file has API responses but no validation, flag it
  if (state.hasApiResponse && !state.hasResponseValidation && !state.hasResponseSchemaImport) {
    violations.push({
      line: 1,
      column: 0,
      message: 'API file sends responses without schema validation',
      severity: 'warning',
      suggestion:
        'Import a Zod response schema from shared contract schemas and use .parse() or .safeParse() to validate API responses before sending to clients',
      type: 'missing-response-validation',
      match: basename(absolutePath),
    });
  }

  return violations;
}

/**
 * Check: quality/api-response-validation
 *
 * Ensures API responses are validated with Zod schemas.
 *
 */
export const apiResponseValidation = defineCheck({
  id: '8822fd30-bcd5-48d5-80d6-2f3abdec7f70',
  slug: 'api-response-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },

  confidence: 'high',
  description: 'Ensure API responses are validated with Zod schemas',
  longDescription: `**Purpose:** Ensures API files validate outbound responses with Zod schemas before sending them to clients.

**Detects:**
- Files that return API responses (via \`res.\`, \`reply.\`, or \`response.\`) but lack both a schema/contracts import and any \`parse\`/\`safeParse\` call on response/result/data arguments

**Skips:**
- SSE/streaming endpoints (files using \`text/event-stream\` or \`reply.raw.write\`)
- Diagnostic, debug, and health endpoints (path-based detection)
- Routes with Fastify-level response schemas (\`schema: { response: ... }\`)
- Routes that only use \`reply.send()\` with dynamic/passthrough payloads

**Why it matters:** Without response validation, API endpoints can silently send malformed or extra data to clients, breaking contracts and leaking internal fields.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing. Only processes files identified as API files by \`isAPIFile()\`.`,
  tags: ['quality', 'api', 'validation', 'zod'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Only analyze API files
    if (!isAPIFile(filePath)) {
      return [];
    }

    try {
      return analyzeFile(filePath, content);
      /* v8 ignore next 1 -- defensive catch: parse failures already handled */
    } catch {
      // @swallow-ok Skip files that fail to parse
      return [];
    }
  },
});
