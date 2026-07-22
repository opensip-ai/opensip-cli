// @fitness-ignore-file correlation-id-coverage -- Fitness check implementation, not an API handler
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

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { filterContent, getSharedSourceFile, unwrapExpression } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

interface CheckRouteSchemaOptions {
  codeText: string;
  method: string;
  line: number;
  filePath: string;
  routePath: string;
  routePropertyNames: ReadonlySet<string>;
  schemaPropertyNames: ReadonlySet<string>;
}

function createSchemaViolation(
  options: CheckRouteSchemaOptions,
  type: string,
  message: string,
  suggestion: string,
): CheckViolation {
  const { method, line, filePath, routePath } = options;
  return {
    filePath,
    line,
    column: 0,
    message,
    severity: 'warning',
    type,
    suggestion,
    match: `${method} ${routePath}`,
  };
}

function hasProperty(options: CheckRouteSchemaOptions, propertyName: string): boolean {
  return propertyName === 'schema'
    ? options.routePropertyNames.has(propertyName)
    : options.schemaPropertyNames.has(propertyName);
}

interface ZodValidationResult {
  hasAny: boolean;
  hasBody: boolean;
  hasQuery: boolean;
  hasParams: boolean;
  hasResponse: boolean;
}

function detectZodValidation(routeText: string): ZodValidationResult {
  const bodyPattern = /\.(?:safe)?[Pp]arse\(\s{0,5}(?:request|req)\.body\s{0,5}\)/;
  const queryPattern = /\.(?:safe)?[Pp]arse\(\s{0,5}(?:request|req)\.query\s{0,5}\)/;
  const paramsPattern = /\.(?:safe)?[Pp]arse\(\s{0,5}(?:request|req)\.params\s{0,5}\)/;
  const responsePattern = /[A-Z]\w{0,60}Schema\.parse\(/;
  const generalPattern = /[A-Z]\w{0,60}Schema\.(?:safe)?[Pp]arse\(/;

  const hasBody = bodyPattern.test(routeText);
  const hasQuery = queryPattern.test(routeText);
  const hasParams = paramsPattern.test(routeText);
  const hasResponse = responsePattern.test(routeText);
  const hasGeneral = generalPattern.test(routeText);

  return {
    hasAny: hasBody || hasQuery || hasParams || hasResponse || hasGeneral,
    hasBody,
    hasQuery,
    hasParams,
    hasResponse,
  };
}

function checkMissingSchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  return schemaViolationUnlessCovered({
    options,
    propertyName: 'schema',
    coveredByZod: zodResult.hasAny,
    type: 'missing-schema',
    message: `Route ${options.method} ${options.routePath} has no schema option`,
    suggestion:
      'Add schema option with body, response, params, and querystring as needed for request validation and OpenAPI documentation. Alternatively, use Zod Schema.parse() or Schema.safeParse() on request properties in the handler.',
  });
}

function handlerReadsBody(routeText: string): boolean {
  // The route's text passed in here covers the full call expression,
  // including the handler body. If neither `request.body` nor `req.body`
  // appears, the handler doesn't consume a request body — POST/PUT/PATCH
  // routes triggered purely by URL params (state-transition actions like
  // `/dispatch`, `/replay`, `/dismiss`) legitimately have no body schema
  // because there is no body. Flagging those is a false positive.
  return routeText.includes('request.body') || routeText.includes('req.body');
}

function checkMissingBodySchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  if (!BODY_METHODS.has(options.method)) {
    return null;
  }
  if (hasProperty(options, 'body')) {
    return null;
  }
  if (zodResult.hasBody) {
    return null;
  }
  if (!handlerReadsBody(options.codeText)) {
    return null;
  }
  return createSchemaViolation(
    options,
    'missing-body-schema',
    `Route ${options.method} ${options.routePath} missing body schema`,
    'Add body schema to validate request payload. Use Zod schema from shared contract schemas.',
  );
}

function checkMissingResponseSchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  return schemaViolationUnlessCovered({
    options,
    propertyName: 'response',
    coveredByZod: zodResult.hasResponse,
    type: 'missing-response-schema',
    message: `Route ${options.method} ${options.routePath} missing response schema`,
    suggestion:
      'Add response schema for proper API documentation and type safety. Define schemas for 200, 400, 500 status codes.',
  });
}

function schemaViolationUnlessCovered(input: {
  readonly options: CheckRouteSchemaOptions;
  readonly propertyName: string;
  readonly coveredByZod: boolean;
  readonly type: string;
  readonly message: string;
  readonly suggestion: string;
}): CheckViolation | null {
  if (hasProperty(input.options, input.propertyName)) {
    return null;
  }
  if (input.coveredByZod) {
    return null;
  }
  return createSchemaViolation(input.options, input.type, input.message, input.suggestion);
}

function checkMissingParamsSchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  const hasParams = options.routePath.includes(':');
  if (!hasParams) {
    return null;
  }
  if (hasProperty(options, 'params')) {
    return null;
  }
  if (zodResult.hasParams) {
    return null;
  }
  return createSchemaViolation(
    options,
    'missing-params-schema',
    `Route ${options.method} ${options.routePath} has path params but no params schema`,
    'Add params schema to validate path parameters. Use Zod schema to validate param types.',
  );
}

function checkMissingQuerySchema(
  options: CheckRouteSchemaOptions,
  zodResult: ZodValidationResult,
): CheckViolation | null {
  const accessesQuery =
    options.codeText.includes('request.query') || options.codeText.includes('req.query');
  if (!accessesQuery) {
    return null;
  }
  if (hasProperty(options, 'querystring')) {
    return null;
  }
  if (zodResult.hasQuery) {
    return null;
  }
  return createSchemaViolation(
    options,
    'missing-querystring-schema',
    `Route ${options.method} ${options.routePath} accesses query but no querystring schema`,
    'Add querystring schema to validate query parameters. Use Zod schema to validate and coerce query string values.',
  );
}

function checkRouteSchema(options: CheckRouteSchemaOptions): CheckViolation[] {
  const violations: CheckViolation[] = [];

  const zodResult = detectZodValidation(options.codeText);

  const missingSchemaViolation = checkMissingSchema(options, zodResult);
  if (missingSchemaViolation) {
    violations.push(missingSchemaViolation);
    return violations;
  }

  const bodyViolation = checkMissingBodySchema(options, zodResult);
  if (bodyViolation) {
    violations.push(bodyViolation);
  }

  const responseViolation = checkMissingResponseSchema(options, zodResult);
  if (responseViolation) {
    violations.push(responseViolation);
  }

  const paramsViolation = checkMissingParamsSchema(options, zodResult);
  if (paramsViolation) {
    violations.push(paramsViolation);
  }

  const queryViolation = checkMissingQuerySchema(options, zodResult);
  if (queryViolation) {
    violations.push(queryViolation);
  }

  return violations;
}

function propertyNameText(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!('name' in property) || property.name === undefined) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
    return property.name.text;
  }
  if (ts.isComputedPropertyName(property.name)) {
    const expression = unwrapExpression(property.name.expression);
    if (ts.isStringLiteralLike(expression)) return expression.text;
  }
  return undefined;
}

function literalProperty(node: ts.ObjectLiteralExpression, propertyName: string): string | null {
  const property = node.properties.find(
    (candidate) => propertyNameText(candidate) === propertyName,
  );
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const initializer = unwrapExpression(property.initializer);
  return ts.isStringLiteralLike(initializer) ? initializer.text : null;
}

function objectRouteMethod(node: ts.ObjectLiteralExpression): string | null {
  const method = literalProperty(node, 'method')?.toUpperCase();
  return method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : null;
}

function propertyNames(node: ts.ObjectLiteralExpression | undefined): ReadonlySet<string> {
  if (!node) return new Set();
  return new Set(
    node.properties
      .map((property) => propertyNameText(property))
      .filter((name): name is string => name !== undefined),
  );
}

function schemaObject(
  node: ts.ObjectLiteralExpression | undefined,
): ts.ObjectLiteralExpression | undefined {
  const schemaProperty = node?.properties.find(
    (property) => propertyNameText(property) === 'schema',
  );
  if (!schemaProperty || !ts.isPropertyAssignment(schemaProperty)) return undefined;
  const initializer = unwrapExpression(schemaProperty.initializer);
  return ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

function shorthandRouteMethod(node: ts.CallExpression, sourceFile: ts.SourceFile): string | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const receiver = node.expression.expression.getText(sourceFile);
  if (!/(?:^|\.)(?:fastify|app|server)$/.test(receiver)) return null;
  const method = node.expression.name.text.toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : null;
}

function routePathArgument(node: ts.CallExpression): string {
  const argument = node.arguments[0];
  if (!argument) return '';
  const unwrapped = unwrapExpression(argument);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : '';
}

function analyzeObjectLiteral(
  node: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation[] {
  const nodeText = node.getText(sourceFile);
  const method = objectRouteMethod(node);
  const routePath = literalProperty(node, 'url');

  if (!method || !routePath) {
    return [];
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

  return checkRouteSchema({
    codeText: filterContent(nodeText, filePath).codeNoCommentsOrRegexLiterals,
    method,
    line: line + 1,
    filePath,
    routePath,
    routePropertyNames: propertyNames(node),
    schemaPropertyNames: propertyNames(schemaObject(node)),
  });
}

function analyzeCallExpression(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation[] {
  const callText = node.getText(sourceFile);
  const method = shorthandRouteMethod(node, sourceFile);

  if (!method) {
    return [];
  }

  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const routePath = routePathArgument(node);
  const routeOptions = node.arguments[1];
  const unwrappedRouteOptions = routeOptions ? unwrapExpression(routeOptions) : undefined;
  const routeOptionsObject =
    unwrappedRouteOptions && ts.isObjectLiteralExpression(unwrappedRouteOptions)
      ? unwrappedRouteOptions
      : undefined;

  return checkRouteSchema({
    codeText: filterContent(callText, filePath).codeNoCommentsOrRegexLiterals,
    method,
    line: line + 1,
    filePath,
    routePath,
    routePropertyNames: propertyNames(routeOptionsObject),
    schemaPropertyNames: propertyNames(schemaObject(routeOptionsObject)),
  });
}

function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return [];

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        violations.push(...analyzeObjectLiteral(node, sourceFile, filePath));
      } else if (ts.isCallExpression(node)) {
        violations.push(...analyzeCallExpression(node, sourceFile, filePath));
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

function isRouteFile(file: string): boolean {
  const hasRouteKeyword =
    file.includes('route') || file.includes('controller') || file.includes('endpoint');
  const isTypeFile = file.endsWith('.d.ts');
  return hasRouteKeyword && !isTestFile(file) && !isTypeFile;
}

export const fastifySchemaCoverage = defineCheck({
  id: '16f14276-7a70-43bb-8097-181dd277371c',
  slug: 'fastify-schema-coverage',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

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
      return [];
    }

    if (!content.includes('fastify') && !content.includes('route')) {
      return [];
    }

    return analyzeFile(content, filePath);
  },
});
