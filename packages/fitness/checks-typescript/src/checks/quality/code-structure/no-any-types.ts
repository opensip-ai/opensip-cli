/**
 * @fileoverview No Any Types Check
 *
 * Detects usage of 'any' type in TypeScript code. The 'any' type bypasses
 * type checking and should be replaced with 'unknown' with proper type narrowing.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Quick filter keywords for 'any' type patterns
 */
const QUICK_FILTER_KEYWORDS = [': any', 'any)', 'any,', 'any;', '<any', 'any>'];

/**
 * Find lines with eslint-disable-next-line comments
 */
function findDisabledLines(content: string): Set<number> {
  const disabledLines = new Set<number>();
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    if (line?.includes('eslint-disable-next-line')) {
      disabledLines.add(i + 1);
    }
  }

  return disabledLines;
}

/**
 * Analyze a file for 'any' type usage
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const disabledLines = findDisabledLines(content);

  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return violations;

    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const parent = node.parent;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

        // Skip if this line has an eslint-disable-next-line comment
        if (disabledLines.has(line)) {
          ts.forEachChild(node, visit);
          return;
        }

        // Get context from parent
        let context = 'type annotation';
        if (ts.isParameter(parent)) {
          context = 'function parameter';
        } else if (ts.isVariableDeclaration(parent)) {
          context = 'variable declaration';
        } else if (ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)) {
          context = 'property';
        } else if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) {
          context = 'return type';
        } else if (ts.isTypeAliasDeclaration(parent)) {
          context = 'type alias';
        }

        violations.push({
          line: line + 1,
          column: character + 1,
          message: `'any' type used in ${context}`,
          severity: 'error',
          type: 'any-type',
          suggestion:
            "Replace 'any' with 'unknown' and add type narrowing with type guards or assertion functions.",
          match: 'any',
          filePath,
        });
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
 * Check: quality/no-any-types
 *
 * Detects usage of any type - use unknown with type narrowing instead.
 */
export const noAnyTypes = defineCheck({
  id: '3d456769-bbcb-461f-8efd-e7b340dcb1b8',
  slug: 'no-any-types',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  description: 'Detect usage of any type - use unknown with type narrowing instead',
  longDescription: `**Purpose:** Detects usage of the \`any\` type in TypeScript code, which bypasses type checking and should be replaced with \`unknown\` plus proper type narrowing.

**Detects:** Analyzes each file individually using TypeScript AST traversal for \`AnyKeyword\` nodes.
- \`any\` in function parameters, variable declarations, property signatures, return types, and type aliases
- Respects \`eslint-disable-next-line\` comments on the preceding line
- Uses a quick-filter optimization: skips files not containing \`: any\`, \`any)\`, \`any,\`, \`any;\`, \`<any\`, or \`any>\`

**Why it matters:** The \`any\` type disables TypeScript's type safety, hiding bugs that would otherwise be caught at compile time. Using \`unknown\` with type guards preserves safety while handling dynamic data.

**Scope:** General best practice`,
  tags: ['quality', 'type-safety', 'code-quality'],
  fileTypes: ['ts', 'tsx'],
  confidence: 'high',

  analyze(content: string, filePath: string): CheckViolation[] {
    // Quick filter: skip files without 'any' type patterns
    if (!QUICK_FILTER_KEYWORDS.some((kw) => content.includes(kw))) {
      return [];
    }

    return analyzeFile(content, filePath);
  },
});
