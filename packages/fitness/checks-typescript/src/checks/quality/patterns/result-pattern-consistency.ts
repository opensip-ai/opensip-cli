// @fitness-ignore-file canonical-result-usage -- References Result pattern in JSDoc for check documentation, not actual Result usage
/**
 * @fileoverview Result Pattern Consistency Check
 *
 * Enforces consistent use of Result<T,E> vs throw based on error type:
 * - Result<T,E> for expected failures (validation, not found, business rules)
 * - throw for unexpected failures (system errors, security issues)
 *
 * @see CLAUDE.md Error Handling Policy
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Expected error types that should use Result pattern
 */
const EXPECTED_ERROR_TYPES = [
  'ValidationError',
  'NotFoundError',
  'BusinessRuleError',
  'ConflictError',
  'InvalidInputError',
  'DuplicateError',
];

/**
 * Function name patterns where throwing is legitimate (validation/guard helpers
 * + infrastructure-boundary factories, resolvers, loaders, parsers, mappers).
 *
 * Factory/resolver/loader helpers (`defineX`, `resolveX`, `loadX`, `parseX`,
 * `mapXTo…`) are startup-time configuration entry points: a malformed input
 * is a programmer error caught once at boot rather than a recoverable
 * business-logic failure, so they throw eagerly. Forcing them to return
 * `Result` would push a startup-error branch into every call site — a
 * usability regression, not consistency.
 */
const LEGITIMATE_THROW_FUNCTION_PATTERNS = [
  /^validate[A-Z]/,
  /^assert[A-Z]/,
  /^ensure[A-Z]/,
  /^require[A-Z]/,
  /^check[A-Z]/,
  /^verify[A-Z]/,
  /^must[A-Z]/,
  /^define[A-Z]/,
  /^resolve[A-Z]/,
  /^load[A-Z]/,
  /^parse[A-Z]/,
  /^map[A-Z]\w*To[A-Z]/,
  /Guard$/,
  /Validator$/,
  /Assertion$/,
];

/**
 * Paths where throwing is expected (infrastructure boundaries per DEC-015).
 * These are entry points that bridge external systems, CLI, or pipeline layers
 * where callers can't meaningfully recover — throw is the correct pattern.
 */
const THROW_ALLOWED_PATHS = [
  /\/routes\//,
  /\/handlers\//,
  /\/controllers\//,
  /\/middleware\//,
  /\/plugins?\//,
  /\/bootstrap/,
  /\/providers\//,
  // Internal services
  /\/services\/internal\//,
  // Validation utilities
  /\/utils\/validation/,
  // LLM and external API adapters (bridge external services)
  /\/llm\//,
  /\/adapters\//,
  /\/embeddings\//,
  // CLI command entry points (bridge CLI to domain)
  /\/commands\//,
  // Pipeline governance and orchestration boundaries
  /\/governor\//,
  /\/prompt\//,
  // ID parsing/validation (infrastructure boundary for data integrity)
  /\/ids\//,
  // Infrastructure boundary packages and patterns (DEC-015: throw is correct)
  /packages\/infrastructure\//,
  /\/stores\//,
  /\/registry\//,
];

/**
 * File name patterns where throwing is legitimate (infrastructure boundary classes)
 */
const INFRASTRUCTURE_FILE_PATTERNS = [/registry/i, /-registry/i, /store/i, /-store/i, /adapter/i];

/**
 * Check if a file path is in a throw-allowed context
 */
function isThrowAllowedPath(filePath: string): boolean {
  if (THROW_ALLOWED_PATHS.some((pattern) => pattern.test(filePath))) {
    return true;
  }

  // Check file name against infrastructure patterns (registries, stores, adapters)
  /* v8 ignore next -- defensive nullish fallback */
  const fileName = filePath.split('/').pop() ?? '';
  return INFRASTRUCTURE_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

/**
 * Check if a function name indicates it's a validation/guard helper
 */
function isValidationHelper(funcName: string): boolean {
  return LEGITIMATE_THROW_FUNCTION_PATTERNS.some((pattern) => pattern.test(funcName));
}

/**
 * Check if a throw statement is inside a catch block (re-throw pattern)
 */
function isInCatchBlock(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isCatchClause(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Get the containing function name for a node
 */
function getContainingFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }

    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isMethodDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }
    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.getText(sourceFile);
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if a node is inside a constructor (constructors should throw, not return Result)
 */
function isInConstructor(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isConstructorDeclaration(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Check if a node is inside a private method (private methods may throw for internal consistency)
 */
function isInPrivateMethod(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isMethodDeclaration(current)) {
      const modifiers = ts.getModifiers(current);
      if (modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/** Options for checkThrowStatement */
interface CheckThrowStatementOptions {
  node: ts.ThrowStatement;
  sourceFile: ts.SourceFile;
  filePath: string;
}

/**
 * Checks a throw statement for expected error types that should use Result pattern
 */
function checkThrowStatement(options: CheckThrowStatementOptions): CheckViolation | null {
  const { node, sourceFile, filePath } = options;

  // Skip files in throw-allowed paths (routes, handlers, plugins)
  if (isThrowAllowedPath(filePath)) {
    return null;
  }

  // Skip re-throws in catch blocks (error wrapping is legitimate)
  if (isInCatchBlock(node)) {
    return null;
  }

  // Skip constructors (constructor validation should throw, not return Result)
  if (isInConstructor(node)) {
    return null;
  }

  // Skip private methods (internal consistency checks may throw)
  if (isInPrivateMethod(node)) {
    return null;
  }

  // Skip validation/guard helper functions
  const funcName = getContainingFunctionName(node, sourceFile);
  if (funcName && isValidationHelper(funcName)) {
    return null;
  }

  const throwText = node.expression.getText(sourceFile);

  // Find the first matching expected error type
  const matchedErrorType = EXPECTED_ERROR_TYPES.find((errorType) => throwText.includes(errorType));
  if (!matchedErrorType) {
    return null;
  }

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const lineNum = line + 1;
  const matchText = node.getText(sourceFile);

  return {
    line: lineNum,
    column: character + 1,
    message: `Throwing ${matchedErrorType} instead of returning Result`,
    severity: 'warning',
    suggestion: `Replace 'throw new ${matchedErrorType}(...)' with 'return err(new ${matchedErrorType}(...))' and update the function return type to Result<T, ${matchedErrorType}>`,
    match: matchText,
  };
}

/** Options for checkResultFunctionBody */
interface CheckResultFunctionBodyOptions {
  bodyText: string;
  node: ts.FunctionDeclaration | ts.MethodDeclaration;
  sourceFile: ts.SourceFile;
  filePath: string;
}

/**
 * Checks function body for thrown expected errors when return type is Result
 */
function checkResultFunctionBody(options: CheckResultFunctionBodyOptions): CheckViolation | null {
  const { bodyText, node, sourceFile, filePath } = options;

  // Skip files in throw-allowed paths
  if (isThrowAllowedPath(filePath)) {
    return null;
  }

  // Skip private methods (internal consistency checks may throw)
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isMethodDeclaration(node)) {
    const modifiers = ts.getModifiers(node);
    if (modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) {
      return null;
    }
  }

  // Get function name
  const funcName =
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      ? node.name?.getText(sourceFile)
      : undefined;

  // Skip validation helper functions
  if (funcName && isValidationHelper(funcName)) {
    return null;
  }

  for (const errorType of EXPECTED_ERROR_TYPES) {
    if (!bodyText.includes(`throw new ${errorType}`)) continue;

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const lineNum = line + 1;
    const matchText = `throw new ${errorType}`;

    return {
      line: lineNum,
      column: character + 1,
      message: `Function returns Result but throws ${errorType}`,
      severity: 'error',
      suggestion: `This function declares Result<T,E> return type but throws ${errorType}. Replace 'throw new ${errorType}(...)' with 'return err(new ${errorType}(...))' for consistency`,
      match: matchText,
    };
  }

  return null;
}

/**
 * Check: quality/result-pattern-consistency
 *
 * Ensures consistent use of Result<T,E> for expected failures and throw for unexpected failures.
 */
export const resultPatternConsistency = defineCheck({
  id: '137e8d24-8b06-4d1f-b5f0-e7542d932679',
  slug: 'result-pattern-consistency',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description:
    'Ensures consistent use of Result<T,E> for expected failures and throw for unexpected failures',
  longDescription: `**Purpose:** Enforces that expected failures (validation, not-found, business rules) use \`Result<T,E>\` while \`throw\` is reserved for unexpected failures (DEC-015).

**Detects:** Analyzes each file individually using TypeScript AST. Checks for:
- \`throw new\` statements using expected error types (\`ValidationError\`, \`NotFoundError\`, \`BusinessRuleError\`, \`ConflictError\`, \`InvalidInputError\`, \`DuplicateError\`) outside catch blocks and non-validation helper functions
- Functions with \`Result\` return type that also contain \`throw new <ExpectedError>\` statements

**Why it matters:** Mixing throw and Result for the same error category forces callers to handle both patterns, creating inconsistent and fragile error handling.

**Scope:** Codebase-specific convention (see CLAUDE.md Error Handling Policy)`,
  tags: ['error-handling', 'quality', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    // Quick filter: skip files without error patterns
    const hasErrorPatterns = content.includes('throw') || content.includes('Result');
    if (!hasErrorPatterns) {
      return [];
    }

    const violations: CheckViolation[] = [];

    const sourceFile = getSharedSourceFile(filePath, content);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return [];

    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);

      // Check throw statements for expected error types
      if (ts.isThrowStatement(node)) {
        const violation = checkThrowStatement({ node, sourceFile, filePath });
        if (violation) {
          violations.push(violation);
        }
        return;
      }

      // Check functions that return Result but also throw expected errors
      if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) return;

      const returnType = node.type?.getText(sourceFile);
      // Require the canonical generic form `Result<…>` (also matches
      // `Promise<Result<…>>`). A bare substring match for "Result"
      // misclassifies domain types like `GateCompareResult`, `AnalyzeResult`,
      // or `ParseResult` as Result-returning and produces false positives
      // wherever such a function throws on a legitimate infrastructure
      // boundary. Word-boundary + `<` preserves the intent without matching
      // unrelated trailing-token names.
      if (!returnType || !/\bResult\s*</.test(returnType)) return;

      /* v8 ignore next -- defensive nullish fallback */
      const bodyText = node.body?.getText(sourceFile) ?? '';
      const violation = checkResultFunctionBody({ bodyText, node, sourceFile, filePath });
      if (violation) {
        violations.push(violation);
      }
    };

    visit(sourceFile);
    return violations;
  },
});
