/**
 * @fileoverview Heavy import detection
 * @module checks-builtin/checks/architecture/heavy-import-detection
 *
 * Detects imports that unnecessarily bloat bundle size:
 * - Full/namespace imports of tree-shakeable libraries (import * as _ from 'lodash')
 * - Deprecated library usage (moment -> date-fns/dayjs, aws-sdk v2 -> v3)
 * - Excessive named imports from a single module (>15 items)
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

interface HeavyLibrary {
  pattern: RegExp;
  message: string;
  suggestion: string;
  deprecated?: boolean;
}

const HEAVY_LIBRARIES: HeavyLibrary[] = [
  {
    pattern: /import\s+\*\s+as\s+\w+\s+from\s+['"]lodash['"]/,
    message: 'Namespace import of lodash pulls in the entire library (~70KB)',
    suggestion:
      "Use named imports: import { debounce } from 'lodash' or import debounce from 'lodash/debounce'",
  },
  {
    pattern: /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]moment['"]/,
    message: 'moment.js is deprecated and heavy (~300KB). Use date-fns or dayjs instead',
    suggestion: "Replace with: import { format } from 'date-fns' or import dayjs from 'dayjs'",
    deprecated: true,
  },
  {
    pattern: /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]aws-sdk['"]/,
    message: 'aws-sdk v2 is deprecated and heavy. Use modular v3 packages',
    suggestion: "Replace with modular import: import { S3Client } from '@aws-sdk/client-s3'",
    deprecated: true,
  },
  {
    pattern: /import\s+\*\s+as\s+\w+\s+from\s+['"]rxjs['"]/,
    message: 'Namespace import of rxjs pulls in the entire library. Use specific imports',
    suggestion:
      "Use: import { Observable, map } from 'rxjs' or import { map } from 'rxjs/operators'",
  },
];

const EXCESSIVE_NAMED_IMPORT_THRESHOLD = 15;
const NAMED_IMPORT_PATTERN = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/;

export const heavyImportDetection = defineCheck({
  id: 'ebd495d1-ae48-478d-a1cc-4823a18cada6',
  slug: 'heavy-import-detection',
  contentFilter: 'strip-strings',
  scope: {
    languages: ['typescript', 'javascript'],
    concerns: ['backend', 'frontend'],
  },
  confidence: 'high',
  description:
    'Detects heavy/deprecated library imports and excessive named imports that bloat bundle size',
  tags: ['architecture', 'performance', 'bundle-size'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  // eslint-disable-next-line sonarjs/cognitive-complexity -- bundler-aware heuristic: each branch detects a distinct heavy-import pattern (deprecated, namespace, deep-path, named-import-explosion)
  analyze(content: string, filePath: string): CheckViolation[] {
    if (filePath.includes('.test.') || filePath.includes('__tests__')) return [];

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
      if (!line) continue;

      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // Check heavy library patterns
      for (const lib of HEAVY_LIBRARIES) {
        if (lib.pattern.test(line)) {
          violations.push({
            line: i + 1,
            message: lib.message,
            severity: lib.deprecated ? 'error' : 'warning',
            suggestion: lib.suggestion,
            type: lib.deprecated ? 'DEPRECATED_LIBRARY' : 'HEAVY_IMPORT',
            match: trimmed,
            filePath,
          });
        }
      }

      // Check excessive named imports
      const namedMatch = NAMED_IMPORT_PATTERN.exec(line);
      if (namedMatch?.[1]) {
        const names = namedMatch[1].split(',').filter((n) => n.trim().length > 0);
        if (names.length > EXCESSIVE_NAMED_IMPORT_THRESHOLD) {
          violations.push({
            line: i + 1,
            message: `Excessive named imports: ${names.length} items from '${namedMatch[2]}'. Consider splitting into multiple import groups.`,
            severity: 'warning',
            suggestion:
              'Split into multiple focused imports or evaluate if all imports are needed.',
            type: 'EXCESSIVE_NAMED_IMPORTS',
            match: `${names.length} imports from ${namedMatch[2]}`,
            filePath,
          });
        }
      }
    }

    return violations;
  },
});
