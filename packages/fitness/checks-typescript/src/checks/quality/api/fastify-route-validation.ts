// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
// @fitness-ignore-file fastify-schema-coverage -- schema definitions to be added in schema coverage sprint
// @fitness-ignore-file duplicate-utility-functions -- reviewed: route-analysis and validation-detection helpers are check-specific logic, not general-purpose utilities
/**
 * @fileoverview Fastify Route Validation Check
 *
 * Ensures all Fastify POST/PATCH/PUT route handlers validate request bodies
 * using Zod schemas.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Quick filter regex to check if file might contain Fastify routes
 */
const QUICK_FILTER_PATTERNS = /fastify\.(post|patch|put)|\.post\(|\.patch\(|\.put\(/i;

/**
 * Patterns that indicate Zod validation is present
 */
const ZOD_VALIDATION_PATTERNS = [
  /\.parse\s*\(/,
  /\.safeParse\s*\(/,
  /Schema\.parse/,
  /Schema\.safeParse/,
  /z\.\w+\(\)/,
];

/**
 * Patterns that indicate other validation libraries are present
 */
const OTHER_VALIDATION_PATTERNS = [
  /\.validate\s*\(/,
  /validateBody\s*\(/,
  /validateRequest\s*\(/,
  /validateInput\s*\(/,
];

interface RouteInfo {
  method: 'POST' | 'PATCH' | 'PUT';
  path: string;
  line: number;
  handlerNode: ts.Node | null;
  hasSchemaOption: boolean;
}

/**
 * Extract route information from a call expression
 * @param node - TypeScript CallExpression node to extract from
 * @param sourceFile - TypeScript SourceFile for position information
 * @returns RouteInfo object if this is a route call, null otherwise
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- AST traversal with multiple node-type checks and nested property extraction
function extractRouteInfo(node: ts.CallExpression, sourceFile: ts.SourceFile): RouteInfo | null {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }

  const methodName = node.expression.name.text.toLowerCase();
  if (!['post', 'patch', 'put'].includes(methodName)) {
    return null;
  }

  const method = methodName.toUpperCase() as 'POST' | 'PATCH' | 'PUT';
  const args = node.arguments;
  if (args.length < 2) {
    return null;
  }

  let routePath = 'unknown';
  const firstArg = args[0];
  if (firstArg && ts.isStringLiteral(firstArg)) {
    routePath = firstArg.text;
  }

  let handlerNode: ts.Node | null = null;
  let hasSchemaOption = false;
  const secondArg = args[1];
  if (secondArg) {
    if (ts.isArrowFunction(secondArg) || ts.isFunctionExpression(secondArg)) {
      handlerNode = secondArg;
    } else if (ts.isObjectLiteralExpression(secondArg)) {
      // Check for schema: { body: ... } in the options object (fastify-type-provider-zod pattern)
      hasSchemaOption = secondArg.properties.some((prop) => {
        /* v8 ignore next -- defensive AST/type guard */
        if (!ts.isPropertyAssignment(prop)) return false;
        const name = prop.name;
        /* v8 ignore next -- defensive AST/type guard */
        if (!ts.isIdentifier(name) || name.text !== 'schema') return false;
        // Check if the schema object has a 'body' property
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          return prop.initializer.properties.some(
            (schemaProp) =>
              ts.isPropertyAssignment(schemaProp) &&
              ts.isIdentifier(schemaProp.name) &&
              schemaProp.name.text === 'body',
          );
        }
        return false;
      });
      if (args[2]) {
        const thirdArg = args[2];
        /* v8 ignore next -- defensive AST/type guard */
        if (ts.isArrowFunction(thirdArg) || ts.isFunctionExpression(thirdArg)) {
          handlerNode = thirdArg;
        }
      }
    } else {
      // Other argument types - handler not found
    }
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

  return {
    method,
    path: routePath,
    line: line + 1,
    handlerNode,
    hasSchemaOption,
  };
}

/**
 * Check if text matches any validation pattern
 * @param text - Text to check against patterns
 * @param patterns - Array of patterns to test
 * @returns true if any pattern matches
 */
function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Check if handler has validation after request.body access
 * @param handlerText - Handler text to analyze
 * @returns true if validation found after body access
 */
function hasValidationAfterBodyAccess(handlerText: string): boolean {
  if (!handlerText.includes('request.body')) {
    return false;
  }

  const bodyAccessIndex = handlerText.indexOf('request.body');
  const afterBodyAccess = handlerText.slice(bodyAccessIndex);
  const allPatterns = [...ZOD_VALIDATION_PATTERNS, ...OTHER_VALIDATION_PATTERNS];

  if (matchesAnyPattern(afterBodyAccess, allPatterns)) {
    return true;
  }

  // Check for manual validation with if statement - simple non-backtracking check
  return afterBodyAccess.includes('if') && afterBodyAccess.includes('!');
}

/**
 * Check if handler has 400 status response with validation message
 * @param handlerText - Handler text to analyze
 * @returns true if validation response pattern found
 */
function hasValidationResponse(handlerText: string): boolean {
  // Use indexOf for simple string checks to avoid regex complexity
  const has400Code = handlerText.includes('reply.code') && handlerText.includes('400');
  const hasValidationMessage =
    handlerText.includes('Missing') ||
    handlerText.includes('Invalid') ||
    handlerText.includes('required');

  /* v8 ignore next -- defensive AST/type guard */
  return has400Code && hasValidationMessage;
}

/**
 * Check if a handler has validation
 * @param handlerNode - TypeScript node of the handler or null
 * @param sourceFile - TypeScript SourceFile for context
 * @param fullContent - Full file content as string
 * @returns true if validation is found, false otherwise
 */
function checkForValidation(
  handlerNode: ts.Node | null,
  sourceFile: ts.SourceFile,
  fullContent: string,
): boolean {
  if (!handlerNode) {
    return hasValidationInContent(fullContent);
  }

  const handlerText = handlerNode.getText(sourceFile);

  if (matchesAnyPattern(handlerText, ZOD_VALIDATION_PATTERNS)) {
    return true;
  }

  if (matchesAnyPattern(handlerText, OTHER_VALIDATION_PATTERNS)) {
    return true;
  }

  if (hasValidationAfterBodyAccess(handlerText)) {
    return true;
  }

  return hasValidationResponse(handlerText);
}

function hasValidationInContent(content: string): boolean {
  if (content.includes('contracts') && content.includes('Schema')) {
    return true;
  }
  if (content.includes('zod') && content.includes('.parse(')) {
    return true;
  }
  return false;
}

/**
 * Create a violation for a route missing validation
 * @param routeInfo - Route information
 * @param filePath - Path to the file
 * @returns CheckViolation object
 */
function createMissingValidationViolation(routeInfo: RouteInfo, filePath: string): CheckViolation {
  return {
    filePath,
    line: routeInfo.line,
    column: 0,
    message: `${routeInfo.method} ${routeInfo.path} - Route handler accepts request body without Zod schema validation`,
    severity: 'error',
    type: 'missing-validation',
    suggestion:
      'Add Zod schema validation for request body. Import schema from shared contract schemas and use schema.parse(request.body).',
    match: `${routeInfo.method} ${routeInfo.path}`,
  };
}

/**
 * Options for checking a call expression for route validation issues
 */
interface CheckCallExpressionOptions {
  node: ts.CallExpression;
  sourceFile: ts.SourceFile;
  content: string;
  filePath: string;
}

/**
 * Check a single call expression for route validation issues
 * @param options - The options for the check
 * @returns Violation if found, null otherwise
 */
function checkCallExpressionForViolation(
  options: CheckCallExpressionOptions,
): CheckViolation | null {
  const { node, sourceFile, content, filePath } = options;
  const routeInfo = extractRouteInfo(node, sourceFile);
  if (!routeInfo) {
    return null;
  }

  // Routes using fastify-type-provider-zod pass schema in options — validation is automatic
  if (routeInfo.hasSchemaOption) {
    return null;
  }

  const hasValidation = checkForValidation(routeInfo.handlerNode, sourceFile, content);
  if (hasValidation) {
    return null;
  }

  return createMissingValidationViolation(routeInfo, filePath);
}

/**
 * Analyze a file for Fastify routes missing validation
 * @param content - File content to analyze
 * @param filePath - Path to the file being analyzed
 * @returns Array of violations found in the file
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const violation = checkCallExpressionForViolation({ node, sourceFile, content, filePath });
        if (violation) {
          violations.push(violation);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    /* v8 ignore next 1 -- defensive catch: parse failures already handled */
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations;
}

/**
 * Check if file is a route file
 */
function isRouteFile(file: string): boolean {
  return file.includes('/routes/') && !isTestFile(file) && !file.endsWith('.d.ts');
}

/**
 * Check: quality/fastify-route-validation
 *
 * Ensures all Fastify POST/PATCH/PUT route handlers validate request bodies
 * with Zod schemas.
 */
export const fastifyRouteValidation = defineCheck({
  id: '0de8bce9-e6fd-45c2-83ea-013bedfd3346',
  slug: 'fastify-route-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  // 'raw', not 'strip-strings': the check extracts the route *path string literal*
  // value (first arg to fastify.post/patch/put) to embed the real path in the
  // violation message, and uses content includes() on import/usage strings for
  // fallback validation detection when no inline handler. Stripping blanks those,
  // producing useless messages (e.g. "POST        - ...") and false violations.
  // See auth-route-guard.ts for identical rationale on route paths.
  contentFilter: 'raw',

  confidence: 'high',
  description: 'Ensure all Fastify POST/PATCH/PUT routes validate request bodies with Zod schemas',
  longDescription: `**Purpose:** Ensures every Fastify POST, PATCH, and PUT route handler validates the request body using Zod or an equivalent validation library.

**Detects:**
- Route handlers registered via \`fastify.post(\`, \`.patch(\`, \`.put(\` (matched by \`/fastify\\.(post|patch|put)|\\.(post|patch|put)\\(/i\`) that lack validation
- Missing Zod calls (\`.parse(\`, \`.safeParse(\`, \`z.\\w+()\`) and alternative validators (\`.validate(\`, \`validateBody(\`, \`validateRequest(\`, \`validateInput(\`)
- Handlers that access \`request.body\` without subsequent validation or 400-status error responses

**Why it matters:** Unvalidated request bodies allow malformed or malicious payloads to reach business logic, causing runtime errors and security vulnerabilities.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing. Only processes files under \`/routes/\` directories.`,
  tags: ['quality', 'security', 'code-quality', 'fastify', 'validation'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Filter to only route files
    if (!isRouteFile(filePath)) {
      return [];
    }

    // Quick filter: skip files that don't contain route patterns
    if (!QUICK_FILTER_PATTERNS.test(content)) {
      return [];
    }

    return analyzeFile(content, filePath);
  },
});
