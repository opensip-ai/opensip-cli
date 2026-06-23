/**
 * @fileoverview Array Parameter Validation Check
 *
 * Detects array parameters without proper validation.
 * Ensures arrays are validated for length, type, and content before processing.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import {
  isArrayIsArrayCall,
  isComplexNestedType,
  isForwardedToCall,
  isIndexedAccess,
  isIterationOverParam,
  isLengthAccess,
  isOptionalHandling,
  isOutSinkUsage,
  isRelaxedValidationPath,
  isShorthandPropertyReference,
  isSpreadOfParam,
  isTopLevelArrayType,
  isValidationFunctionCall,
  isZodValidationCall,
  QUICK_FILTER_KEYWORDS,
} from './array-validation-detectors.js';

function checkForArrayValidation(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction,
  param: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
): boolean {
  if (!node.body) return false;

  const paramName = ts.isIdentifier(param.name) ? param.name.text : null;
  if (!paramName) return true;

  if (paramName.startsWith('_')) return true;

  let hasValidation = false;

  const visit = (n: ts.Node) => {
    if (isLengthAccess(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isArrayIsArrayCall(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isZodValidationCall(n, sourceFile)) {
      hasValidation = true;
    }
    if (isValidationFunctionCall(n)) {
      hasValidation = true;
    }
    if (isIterationOverParam(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isOptionalHandling(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isOutSinkUsage(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isIndexedAccess(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isSpreadOfParam(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isForwardedToCall(n, paramName, sourceFile)) {
      hasValidation = true;
    }
    if (isShorthandPropertyReference(n, paramName)) {
      hasValidation = true;
    }

    if (!hasValidation) {
      ts.forEachChild(n, visit);
    }
  };

  visit(node.body);
  return hasValidation;
}

interface CheckFunctionArrayParamsOptions {
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction;
  sourceFile: ts.SourceFile;
  absolutePath: string;
}

function checkFunctionArrayParams(options: CheckFunctionArrayParamsOptions): CheckViolation[] {
  const { node, sourceFile, absolutePath } = options;
  const violations: CheckViolation[] = [];

  if (isRelaxedValidationPath(absolutePath)) {
    return violations;
  }

  if (
    ts.isMethodDeclaration(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
  ) {
    return violations;
  }

  const unvalidatedArrayParams = node.parameters.filter((param) => {
    if (!param.type) return false;
    if (!isTopLevelArrayType(param.type)) return false;

    const typeText = param.type.getText(sourceFile);
    if (isComplexNestedType(typeText)) return false;

    return !checkForArrayValidation(node, param, sourceFile);
  });

  for (const param of unvalidatedArrayParams) {
    const paramName = ts.isIdentifier(param.name) ? param.name.text : '<destructured>';
    const { line: lineIdx, character } = sourceFile.getLineAndCharacterOfPosition(param.getStart());
    const line = lineIdx + 1;
    const paramText = param.getText(sourceFile);

    violations.push({
      line,
      column: character + 1,
      message: `Array parameter '${paramName}' lacks validation`,
      severity: 'warning',
      suggestion: `Add validation for '${paramName}' array: check Array.isArray(), validate .length bounds, and/or use Zod schema for content validation`,
      type: 'missing-array-validation',
      match: paramText,
    });
  }

  return violations;
}

function analyzeFile(content: string, absolutePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  if (!QUICK_FILTER_KEYWORDS.some((kw) => content.includes(kw))) {
    return violations;
  }

  const sourceFile = getSharedSourceFile(absolutePath, content);
  if (!sourceFile) return [];

  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)
    ) {
      violations.push(...checkFunctionArrayParams({ node, sourceFile, absolutePath }));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Check: quality/array-validation
 *
 * Detects array parameters without proper validation to prevent
 * runtime errors from unvalidated array inputs.
 */
export const arrayValidation = defineCheck({
  id: 'a9e0e70c-a4af-42e6-bbd7-4c87a72cb7d4',
  slug: 'array-validation',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect array parameters without proper validation',
  longDescription: `**Purpose:** Ensures function parameters with array types are validated before use, preventing runtime errors from malformed or unexpected array inputs.

**Detects:**
- Function/method/arrow-function parameters whose top-level type is an array (\`string[]\`, \`Array<T>\`) and whose body lacks validation
- Missing \`Array.isArray()\` checks, \`.length\` bounds checks, Zod \`.parse()\`/\`.safeParse()\` calls, or calls to functions named \`validate\`/\`check\`
- Uses TypeScript AST node kinds (not text matching) to distinguish true array parameters from object/interface/intersection types that merely contain array-typed properties
- Skips parameters with complex nested types (\`Record<\`, \`Map<\`, \`Promise<\`, function types)
- Excludes files under \`/internal/\`, \`/utils/\`, \`/helpers/\`, \`/cli/\`, \`/scripts/\`

**Why it matters:** Unvalidated arrays can cause silent data corruption, out-of-bounds errors, or type mismatches at runtime that TypeScript's type system alone cannot prevent.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'validation', 'type-safety', 'arrays'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return [];
    return analyzeFile(content, filePath);
  },
});
