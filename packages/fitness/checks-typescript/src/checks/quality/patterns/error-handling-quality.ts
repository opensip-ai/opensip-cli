// @fitness-ignore-file canonical-result-usage -- References Result pattern in comments/JSDoc for pattern detection documentation, not actual Result usage
// @fitness-ignore-file logging-standards -- String literals in suggestion text reference logger calls, not actual logger usage
// @fitness-ignore-file error-handling-quality -- Fitness check implementation: catch blocks in AST analysis intentionally return empty results to skip unreadable files
/**
 * @fileoverview Unified Error Handling Quality Check
 *
 * Detects silent error handling in both try/catch and Result patterns.
 * Replaces: resilience/no-empty-catch, quality/error-swallowing-boolean
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import { getContainingFunctionName } from './containing-function-name.js';

// =============================================================================
// WHITELIST PATTERNS
// =============================================================================

/**
 * Patterns that indicate proper error handling (logging)
 */
const LOGGING_PATTERNS = [
  /logger\.(error|warn|debug|info)\s*\(/,
  /safeLogger\.(error|warn|debug|info)\s*\(/,
  /console\.(error|warn)\s*\(/,
  /\.log\s*\(/,
  /unwrapOrLog\s*\(/,
  /matchLog\s*\(/,
  /handleErr\s*\(/,
];

/**
 * Patterns that indicate intentional silent handling
 */
const MARKER_PATTERNS = [
  /@swallow-ok/,
  /@handles/,
  /\/\/\s*intentionally/i,
  /\/\/\s*expected/i,
  /graceful/i,
];

/**
 * Patterns that indicate error propagation
 */
const PROPAGATION_PATTERNS = [
  /\berr\s*\(/,
  /Result\.err\s*\(/,
  /new\s+Failure\s*\(/,
  /return\s+\S[^\n]*\.error\b/,
];

/**
 * Pattern for rethrow
 */
const RETHROW_PATTERN = /\bthrow\b/;

/**
 * Sentinel return values that indicate silent error handling
 */
const SENTINEL_VALUES = new Set(['false', 'null', 'undefined', '[]', '{}']);

/**
 * Function names where catch → sentinel is the documented contract (filesystem
 * probes, parse-or-null helpers, module-resolution probes).
 */
const PROBE_FUNCTION_NAME_PATTERNS = [
  /^safe[A-Z]/,
  /^isPhantom/,
  /^isPathInside$/,
  /^parseSource$/,
  /^resolveCoreFromAnchor$/,
  /^resolveFitnessFromAnchor$/,
  /^coreVersionFromManifest$/,
  /^resolvePackageEntryPoint$/,
  /^tryDiscoverPackage$/,
  /^readProjectPluginsList$/,
  /^extractTimestamp$/,
  /^readConfigPathFromPackageJson$/,
  /^readPackageJson$/,
  /^readPackageVersion/,
  /^readYaml/,
  /^readGlobalConfig$/,
  /^writeGlobalConfig$/,
  /^loadCliDefaults$/,
  /^resolveProjectConfigPath$/,
  /^isFile$/,
  /^isDirectory$/,
  /^normalizeIdentity$/,
  /^analyzeFileConvention$/,
];

/** Paths where best-effort / composition-root degradation is intentional. */
const COMPOSITION_ROOT_PATH_PATTERNS = [
  /\/bootstrap\//,
  /\/commands\//,
  /\/sink\//,
  /update-state\.ts$/,
  /update-notifier\.ts$/,
  /deliver-envelope\.ts$/,
  /sdk-init\.ts$/,
  /open-report\.ts$/,
  /report-compose\.ts$/,
  /report-data\.ts$/,
  /cache-orchestrator\.ts$/,
  /flat-monorepo-strategy\.ts$/,
  /program-service\.ts$/,
  /workspace-units\.ts$/,
  /graph-adapter-common\/.*discover\.ts$/,
  /graph-typescript\/.*discover\.ts$/,
  /package-version\.ts$/,
  /global-config\.ts$/,
  /phantom-detect\.ts$/,
  /node-modules-walk\.ts$/,
  /parse-cache\.ts$/,
  /logger\.ts$/,
  /entitlement\.ts$/,
  /repo-identity\.ts$/,
  /resolve-signal-sink\.ts$/,
  /https-url\.ts$/,
  /list-files\.ts$/,
  /graph\.ts$/,
  /plugins\/loader\.ts$/,
  /cli-config\.ts$/,
  /init\/state-machine\.ts$/,
  /init\/file-classifier\.ts$/,
  /jwt-validation\.ts$/,
  /config-resolution\.ts$/,
  /public-api-surface\.ts$/,
  /package-entry\.ts$/,
  /tool-package-discovery\.ts$/,
  /single-core-guard\.ts$/,
  /discover\.ts$/,
  /resolve-dependencies\.ts$/,
  /graph-go\/.*resolve\.ts$/,
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function isCompositionRootPath(filePath: string): boolean {
  return COMPOSITION_ROOT_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function isModuleInitResolutionProbe(node: ts.CatchClause, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const bodyText = current.body?.getText(sourceFile) ?? '';
      return (
        bodyText.includes('createRequire') &&
        bodyText.includes('.resolve(') &&
        (bodyText.includes('@opensip-cli/core') || bodyText.includes("'@opensip-cli/"))
      );
    }
    current = current.parent;
  }
  return false;
}

function isProbeFunctionCatch(node: ts.CatchClause, sourceFile: ts.SourceFile): boolean {
  if (isModuleInitResolutionProbe(node, sourceFile)) {
    return true;
  }
  const funcName = getContainingFunctionName(node, sourceFile);
  if (!funcName) {
    return false;
  }
  return PROBE_FUNCTION_NAME_PATTERNS.some((pattern) => pattern.test(funcName));
}

function isResultMatchCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  if (node.expression.name.text !== 'match') {
    return false;
  }
  if (node.arguments.length < 2) {
    return false;
  }
  const [okHandler, errHandler] = node.arguments;
  const isHandler = (arg: ts.Expression | undefined): boolean =>
    arg !== undefined && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
  return isHandler(okHandler) && isHandler(errHandler);
}

/**
 * Check if text contains acceptable error handling
 * @param text - Text to check
 * @returns True if acceptable pattern found
 */
function hasAcceptablePattern(text: string): boolean {
  if (LOGGING_PATTERNS.some((p) => p.test(text))) return true;
  if (MARKER_PATTERNS.some((p) => p.test(text))) return true;
  /* v8 ignore next -- defensive AST/type guard */
  if (PROPAGATION_PATTERNS.some((p) => p.test(text))) return true;
  if (RETHROW_PATTERN.test(text)) return true;
  return false;
}

/**
 * Get return value type from expression
 * @param expr - TypeScript expression
 * @param sourceFile - Source file for getting text
 * @returns String representation or null if not a sentinel
 */
function getReturnValue(expr: ts.Expression | undefined, sourceFile: ts.SourceFile): string | null {
  /* v8 ignore next -- defensive AST/type guard */
  if (!expr) return 'undefined';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isIdentifier(expr) && expr.getText(sourceFile) === 'undefined') return 'undefined';
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return '[]';
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) return '{}';
  return null;
}

// =============================================================================
// CHECK FUNCTIONS
// =============================================================================

/**
 * Check a catch clause for violations
 */
function checkCatchClause(node: ts.CatchClause, sourceFile: ts.SourceFile): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const catchText = node.block.getText(sourceFile);

  if (isProbeFunctionCatch(node, sourceFile)) {
    return violations;
  }

  // Skip if has acceptable pattern
  if (hasAcceptablePattern(catchText)) return violations;

  const trimmed = catchText.replaceAll(/[{}]/g, '').trim();

  // Strip leading single-line comments (`// ...` lines, including
  // multi-line stacks) and block comments before testing for empty.
  // The original regex `/^\/[/*]/` only checked the first character,
  // which falsely flags `} catch { // comment\n actualHandler() }`
  // patterns as empty even though real code follows the comment.
  let codeOnly = trimmed;
  while (true) {
    if (codeOnly.startsWith('//')) {
      const eol = codeOnly.indexOf('\n');
      codeOnly = (eol === -1 ? '' : codeOnly.slice(eol + 1)).trim();
      continue;
    }
    if (codeOnly.startsWith('/*')) {
      const close = codeOnly.indexOf('*/');
      codeOnly = (close === -1 ? '' : codeOnly.slice(close + 2)).trim();
      continue;
    }
    break;
  }

  // Empty catch - SEVERITY: ERROR
  if (trimmed === '' || codeOnly === '') {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push({
      line: line + 1,
      column: 0,
      message: 'Empty catch block silently swallows errors',
      severity: 'error',
      suggestion:
        "Add logging: `logger.error({ evt: 'operation.failed', err })` or add `// @swallow-ok reason`",
      match: 'catch',
    });
    return violations;
  }

  // Check for sentinel returns without logging
  const visitReturn = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      const val = getReturnValue(n.expression, sourceFile);
      if (val && SENTINEL_VALUES.has(val)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(n.getStart());
        violations.push({
          line: line + 1,
          column: 0,
          message: `Catch returns ${val} without logging`,
          severity: 'error',

          suggestion: `Add logging before return: \`logger.warn({ evt: 'operation.failed', err })\``,
          match: `return ${val}`,
        });
      }
    }
    ts.forEachChild(n, visitReturn);
  };
  visitReturn(node.block);

  return violations;
}

/**
 * Check Result.isErr() usage for violations
 */
function checkResultIsErr(node: ts.IfStatement, sourceFile: ts.SourceFile): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const cond = node.expression.getText(sourceFile);
  // @fitness-ignore-next-line error-handling-quality -- String literal check for '.isErr()', not actual Result error handling
  if (!cond.includes('.isErr()')) return violations;

  const thenText = node.thenStatement.getText(sourceFile);
  /* v8 ignore next -- defensive AST/type guard */
  if (hasAcceptablePattern(thenText)) return violations;

  // Check for silent sentinel returns
  const visitReturn = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      const val = getReturnValue(n.expression, sourceFile);
      if (val && SENTINEL_VALUES.has(val)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          line: line + 1,
          column: 0,
          message: `Result error silently discarded - returns ${val}`,
          severity: 'error',
          suggestion: `Use: \`result.unwrapOrLog(${val}, { evt: 'operation.failed' })\``,
          match: 'isErr()',
        });
      }
    }
  };

  if (ts.isBlock(node.thenStatement)) {
    node.thenStatement.statements.forEach(visitReturn);
  } else {
    visitReturn(node.thenStatement);
  }

  return violations;
}

/**
 * Check Result methods for violations
 */
function checkResultMethods(node: ts.CallExpression, sourceFile: ts.SourceFile): CheckViolation[] {
  const violations: CheckViolation[] = [];

  if (!ts.isPropertyAccessExpression(node.expression)) return violations;

  const method = node.expression.name.getText(sourceFile);

  // mapErr without logging - SEVERITY: ERROR
  if (method === 'mapErr' && node.arguments.length > 0) {
    const firstArg = node.arguments[0];
    /* v8 ignore next -- defensive AST/type guard */
    if (!firstArg) return violations;
    const callback = firstArg.getText(sourceFile);
    if (!hasAcceptablePattern(callback)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        line: line + 1,
        column: 0,
        message: 'mapErr() discards error without logging',
        severity: 'error',

        suggestion: 'Add logging: `mapErr(err => { logger.warn({ err }); return default; })`',
        match: 'mapErr',
      });
    }
  }

  // Result.match() error handler without logging - SEVERITY: ERROR
  // (String/RegExp .match() takes a single pattern arg, not two callbacks.)
  if (method === 'match' && isResultMatchCall(node)) {
    const secondArg = node.arguments[1];
    /* v8 ignore next -- defensive AST/type guard */
    if (!secondArg) return violations;
    const errHandler = secondArg.getText(sourceFile);
    if (!hasAcceptablePattern(errHandler)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      violations.push({
        line: line + 1,
        column: 0,
        message: "match() error handler doesn't log",
        severity: 'error',
        suggestion: 'Use matchLog() instead, or add logging to error handler',
        match: 'match',
      });
    }
  }

  return violations;
}

/**
 * Check a catch clause for unsafe `as Error` casts
 */
function checkCatchClauseAsErrorCast(
  node: ts.CatchClause,
  sourceFile: ts.SourceFile,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const catchText = node.block.getText(sourceFile);

  // Skip if the catch block contains an instanceof Error guard
  if (catchText.includes('instanceof Error')) return violations;

  // Check for `as Error` casts
  if (catchText.includes('as Error')) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const catchParam = node.variableDeclaration?.name.getText(sourceFile) ?? 'error';
    violations.push({
      line: line + 1,
      column: 0,
      message: 'Unsafe `as Error` cast in catch block without `instanceof Error` guard',
      severity: 'warning',
      suggestion: `Use \`if (${catchParam} instanceof Error)\` guard or normalize the error with a typed error utility`,
      match: 'as Error',
    });
  }

  return violations;
}

/** Analyze a file for silent error-handling issues. */
export function analyzeFileForErrorHandlingQuality(
  content: string,
  filePath: string,
): CheckViolation[] {
  if (isTestFile(filePath)) return [];
  if (isCompositionRootPath(filePath)) return [];

  if (!content.includes('catch') && !content.includes('isErr') && !content.includes('.match(')) {
    return [];
  }

  const violations: CheckViolation[] = [];

  const sourceFile = getSharedSourceFile(filePath, content);
  /* v8 ignore next -- defensive guard */
  if (!sourceFile) return [];

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      violations.push(
        ...checkCatchClause(node, sourceFile),
        ...checkCatchClauseAsErrorCast(node, sourceFile),
      );
    }
    if (ts.isIfStatement(node)) {
      violations.push(...checkResultIsErr(node, sourceFile));
    }
    if (ts.isCallExpression(node)) {
      violations.push(...checkResultMethods(node, sourceFile));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

// =============================================================================
// CHECK IMPLEMENTATION
// =============================================================================

/**
 * Check: quality/error-handling-quality
 *
 * Detects silent error handling in both try/catch and Result patterns.
 * This is a unified check that replaces:
 * - resilience/no-empty-catch
 * - quality/error-swallowing-boolean
 *
 */
export const errorHandlingQuality = defineCheck({
  id: '6bae5be9-87f4-499e-a886-ca78a233cfb7',
  slug: 'error-handling-quality',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
  confidence: 'high',
  description: 'Detect silent error handling in try/catch and Result patterns',
  longDescription: `**Purpose:** Detects silent error handling in both try/catch blocks and Result pattern usage, ensuring errors are always logged or propagated.

**Detects:** Analyzes each file individually using TypeScript AST. Checks for:
- Empty catch blocks (no logging, no rethrow, no \`@swallow-ok\` marker)
- Catch blocks that return sentinel values (\`false\`, \`null\`, \`undefined\`, \`[]\`, \`{}\`) without logging
- \`result.isErr()\` branches that silently return sentinel values
- \`mapErr()\` callbacks without logging
- \`match()\` error handlers without logging (suggests \`matchLog()\` instead)

**Why it matters:** Silent error handling hides failures, making production debugging nearly impossible and allowing cascading failures to go undetected.

**Scope:** General best practice`,
  tags: ['quality', 'resilience', 'error-handling', 'observability', 'result-pattern'],
  fileTypes: ['ts'],

  analyze: analyzeFileForErrorHandlingQuality,
});
