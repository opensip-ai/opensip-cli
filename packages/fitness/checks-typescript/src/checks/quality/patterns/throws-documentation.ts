// @fitness-ignore-file no-generic-error -- Generic errors appropriate in this context
// @fitness-ignore-file no-hardcoded-timeouts -- framework default for fitness check execution timeout
/**
 * @fileoverview Missing @throws JSDoc Detection Check
 *
 * Detects functions that contain throw statements but lack @throws JSDoc documentation.
 */

import { defineCheck, isTestFile } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';

import { analyzeFile } from './throws-documentation-analyze.js';
import {
  buildEffectiveSuffixes,
  type ThrowsDocConfig,
} from './throws-documentation-constants.js';

export type { ThrowsDocConfig };

/**
 * Check: quality/throws-documentation
 *
 * Detects functions with throw statements but no @throws JSDoc.
 */
export const throwsDocumentation = defineCheck({
  id: 'f4fb7ff5-5927-4b0b-a9cf-d919cd37c931',
  slug: 'throws-documentation',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detects functions with throw statements but no @throws JSDoc',
  longDescription: `**Purpose:** Detects functions that contain \`throw\` statements but lack \`@throws\` JSDoc documentation, ensuring callers know what errors to expect.

**Detects:** Analyzes each file individually using TypeScript AST. Finds function/method/arrow-function declarations with throw statements that have no leading \`@throws\` JSDoc comment. Skips anonymous callbacks, re-throws (\`throw err\`), and self-documenting typed error classes (e.g. \`ValidationError\`, \`NotFoundError\`, and other project error classes).

**Why it matters:** Without \`@throws\` documentation, callers cannot know which errors to handle, leading to unhandled exceptions in production.

**Scope:** Codebase-specific convention enforcing error handling standards`,
  tags: ['quality', 'documentation', 'best-practices'],
  fileTypes: ['ts'],
  timeout: 180_000,

  analyze(content, filePath) {
    if (isTestFile(filePath)) return [];

    if (!content.includes('throw ')) {
      return [];
    }

    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) return [];

    return analyzeFile({
      sourceFile,
      content,
      filePath,
      selfDocumentingSuffixes: buildEffectiveSuffixes(),
    });
  },
});