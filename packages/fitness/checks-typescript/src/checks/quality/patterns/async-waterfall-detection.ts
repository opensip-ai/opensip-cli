/**
 * @fileoverview Async Waterfall Detection Check
 *
 * Detects sequential await statements that could potentially be parallelized
 * with Promise.all(). Uses AST-aware heuristics:
 * - Looks for consecutive lines with await expressions
 * - Flags when the second await doesn't reference the variable from the first
 * - Skips awaits in different conditional branches (if/else, ternary, switch)
 * - Recognizes dynamic import destructuring dependencies
 * - Skips mutex/lock acquire-then-execute patterns
 * - Skips sleep/delay in polling loops
 */

import { defineCheck, isTestFile } from '@opensip-cli/fitness';

import { analyzeFile, MAX_LINE_GAP } from './async-waterfall-analysis.js';

/**
 * Check: quality/async-waterfall-detection
 *
 * Detects sequential await statements that could potentially be parallelized.
 * Uses AST-aware heuristics including:
 * - Consecutive await detection within a configurable line gap
 * - Variable dependency tracking (simple names and destructured bindings)
 * - Conditional branch awareness (if/else, ternary, switch/case)
 * - Dynamic import recognition
 * - Mutex/lock acquire pattern exclusion
 * - Sleep/delay pattern exclusion
 */
export const asyncWaterfallDetection = defineCheck({
  id: 'cf169aa8-906c-4e74-bd48-8c9f59ae3eb7',
  slug: 'async-waterfall-detection',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect sequential await statements that could be parallelized',
  longDescription: `**Purpose:** Detects sequential await statements that could potentially be parallelized with \`Promise.all()\`.

**Detects:** Analyzes each file individually using TypeScript AST. Finds consecutive await expressions (within ${MAX_LINE_GAP + 1} lines) in async functions where the second await does not reference the variable assigned by the first, and both await function calls (matched by trailing parentheses).

**Excludes (not flagged):**
- Awaits in different conditional branches (if/else, ternary, switch/case)
- Dynamic \`await import()\` expressions (next statement almost always depends on the import)
- Destructured binding dependencies (e.g., \`const { x } = await import(...); await x()\`)
- Sleep/delay calls in polling loops (\`await sleep()\`, \`await delay()\`)
- Mutex/lock acquire patterns (\`await this.acquire()\`, \`await lock()\`)
- CLI entry point files (\`**/bin/**\`)

**Why it matters:** Sequential independent awaits double latency unnecessarily; parallelizing them with \`Promise.all()\` can significantly improve performance.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'async', 'patterns'],
  fileTypes: ['ts'],

  analyze(content, filePath) {
    if (isTestFile(filePath)) return [];

    if (!content.includes('await')) {
      return [];
    }

    return analyzeFile(filePath, content);
  },
});
