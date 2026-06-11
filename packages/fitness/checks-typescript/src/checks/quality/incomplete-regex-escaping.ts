// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Incomplete Regex Escaping Check
 *
 * Detects incomplete regex character escaping in .replace() calls.
 * This is a security vulnerability that can lead to regex injection attacks.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';
import { getSharedSourceFile } from '@opensip-tools/lang-typescript';
import * as ts from 'typescript';

/**
 * All special regex characters that should be escaped
 */
const REQUIRED_SPECIAL_CHARS = new Set([
  '\\',
  '^',
  '$',
  '.',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
]);

/**
 * Strip regex delimiters from pattern text
 */
function stripRegexDelimiters(regexText: string): string {
  let pattern = regexText;
  if (pattern.startsWith('/')) {
    pattern = pattern.slice(1);
  }
  if (pattern.includes('/')) {
    /* v8 ignore next -- defensive non-negative guard */
    pattern = pattern.slice(0, Math.max(0, pattern.lastIndexOf('/')));
  }
  return pattern;
}

/**
 * Extract character class content from a pattern starting with [
 */
function extractCharacterClass(pattern: string): string | null {
  let charClass = '';
  let i = 1;

  while (i < pattern.length) {
    const currentChar = pattern[i];
    if (!currentChar) break;
    if (currentChar === '\\' && i + 1 < pattern.length) {
      const nextChar = pattern[i + 1];
      if (nextChar) charClass += currentChar + nextChar;
      i += 2;
    } else if (currentChar === ']') {
      return charClass;
    } else {
      charClass += currentChar;
      i++;
    }
  }
  return null;
}

/**
 * Check if a character is in the character class
 */
function isCharInClass(char: string, charClass: string): boolean {
  if (char === '\\') return charClass.includes('\\\\');
  if (char === ']') return charClass.includes(String.raw`\]`);
  if (char === '^') {
    return (
      charClass.includes(String.raw`\^`) || (charClass.includes('^') && charClass.indexOf('^') > 0)
    );
  }
  if (char === '-') {
    return (
      charClass.includes(String.raw`\-`) || charClass.startsWith('-') || charClass.endsWith('-')
    );
  }
  return charClass.includes(char) || charClass.includes(`\\${char}`);
}

/**
 * Find missing special characters in a regex pattern
 */
function findMissingChars(regexText: string): string[] {
  const pattern = stripRegexDelimiters(regexText);

  if (!pattern.startsWith('[')) {
    return [...REQUIRED_SPECIAL_CHARS];
  }

  const charClass = extractCharacterClass(pattern);
  if (charClass === null) {
    return [...REQUIRED_SPECIAL_CHARS];
  }

  const missingChars: string[] = [];
  for (const char of REQUIRED_SPECIAL_CHARS) {
    if (!isCharInClass(char, charClass)) {
      missingChars.push(char);
    }
  }

  return missingChars;
}

/**
 * Check if a call expression is a .replace() with incomplete escaping
 */
function checkReplaceCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  _filePath: string,
): CheckViolation | null {
  /* v8 ignore next -- defensive AST/type guard */
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== 'replace') return null;
  /* v8 ignore next -- defensive AST/type guard */
  if (node.arguments.length < 2) return null;

  const firstArg = node.arguments[0];
  if (!firstArg || !ts.isRegularExpressionLiteral(firstArg)) return null;

  const secondArg = node.arguments[1];
  /* v8 ignore next -- defensive AST/type guard */
  if (!secondArg || !ts.isStringLiteral(secondArg)) return null;
  if (secondArg.text !== String.raw`\$&`) return null;

  // Check context for intentional partial escaping
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const nodeEnd = node.getEnd();
  /* v8 ignore next -- defensive non-negative guard */
  const contextStart = Math.max(0, nodeStart - 500);
  const contextText = fullText.slice(contextStart, nodeEnd);

  if (/character class|lucene|search|opensearch|elasticsearch|query/i.test(contextText)) {
    return null;
  }

  const regexText = firstArg.text;
  /* v8 ignore next -- defensive AST/type guard */
  if (!regexText) return null;

  const missingChars = findMissingChars(regexText);
  if (missingChars.length === 0) return null;

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

  return {
    line: line + 1,
    column: character + 1,
    message: `Incomplete regex escaping: pattern '${regexText}' is missing special characters: ${missingChars.join(', ')}`,
    severity: 'error',
    type: 'incomplete-escaping',
    suggestion: String.raw`Include all regex special characters in the escape pattern: \\ ^ $ . * + ? ( ) [ ] { } |. Use a library like escape-string-regexp for safety.`,
    match: regexText,
  };
}

/**
 * Check: quality/incomplete-regex-escaping
 *
 * Detects incomplete regex character escaping that can lead to security vulnerabilities.
 */
export const incompleteRegexEscaping = defineCheck({
  id: '62395bfb-8ece-4c82-a6e2-4150b827ac1f',
  slug: 'incomplete-regex-escaping',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description:
    'Detect incomplete regex character escaping that can lead to security vulnerabilities',
  longDescription: `**Purpose:** Detects \`.replace()\` calls that use incomplete regex character class escaping, which can lead to regex injection vulnerabilities.

**Detects:**
- \`.replace(regex, '\\\\$&')\` calls where the regex pattern is missing special characters from the set: \`\\\\ ^ $ . * + ? ( ) [ ] { } |\`
- Uses TypeScript AST to find \`CallExpression\` nodes with \`replace\` property access, a regex literal first argument, and \`'\\\\$&'\` as second argument
- Skips patterns in Lucene/OpenSearch/Elasticsearch contexts (intentional partial escaping)

**Why it matters:** Incomplete regex escaping allows specially crafted input to break out of the intended pattern, enabling regex injection attacks.

**Scope:** General best practice. Analyzes each file individually (\`analyze\`). Targets production files.`,
  tags: ['quality', 'security', 'best-practices'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath): CheckViolation[] {
    // Quick filter: skip files without .replace() calls
    if (!content.includes('.replace(')) {
      return [];
    }

    const violations: CheckViolation[] = [];

    try {
      const sourceFile = getSharedSourceFile(filePath, content);
      /* v8 ignore next -- defensive guard */
      if (!sourceFile) return [];

      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const violation = checkReplaceCall(node, sourceFile, filePath);
          if (violation) violations.push(violation);
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
      /* v8 ignore next 1 -- defensive catch: parse failures already handled */
    } catch {
      // @swallow-ok Skip files that fail to parse
    }

    return violations;
  },
});
