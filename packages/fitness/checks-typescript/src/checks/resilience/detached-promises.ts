// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file canonical-result-usage -- References Result pattern in comments and regex patterns for detection, not actual Result usage
/**
 * @fileoverview Detached promise detection — flags un-awaited promise-returning
 * calls inside async contexts.
 *
 * The defaults here cover **generic JS/TS sync APIs only** (Array, String,
 * Object, Math, JSON, `console.*`, the Node `*Sync` family, timer
 * scheduling, and EventEmitter). Framework-specific helpers (Fastify
 * decorators, Pyroscope SDK, OTel propagation, DBOS `.init`, Vitest /
 * Drizzle helpers, etc.) belong in a recipe's
 * `checks.config['detached-promises']` block — see
 * {@link DetachedPromisesConfig}. The check reads that block via
 * `getCheckConfig` and merges it into the effective sync-call sets.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

import { analyzeFileForDetachedPromises } from './detached-promises-detection.js';
import { type DetachedPromisesConfig } from './detached-promises-sync-constants.js';

export type { DetachedPromisesConfig };

/**
 * Check: resilience/detached-promises
 *
 * Detects promises that are not awaited or handled.
 * Missing await can cause silent failures.
 *
 * Uses AST analysis to:
 * - Only flag calls inside async functions/methods
 * - Skip known synchronous functions (logger.*, ensureCorrelationIdFor, etc.)
 * - Skip fire-and-forget patterns (process.nextTick, setImmediate, etc.)
 */
export const detachedPromises = defineCheck({
  id: 'fda3b4f5-bb4f-4b77-9d0d-9103f958febb',
  slug: 'detached-promises',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect promises that may not be awaited (potential silent failures)',
  longDescription: `**Purpose:** Ensures promises inside async functions are properly awaited to prevent silent failures.

**Detects:**
- Call expressions inside async functions/methods that are neither awaited, assigned, returned, nor voided
- Excludes known synchronous functions (logger methods, array/string/object builtins, Node.js sync APIs, EventEmitter methods)
- Excludes fire-and-forget scheduling calls (\`setImmediate\`, \`setTimeout\`, \`nextTick\`)

**Why it matters:** Unhandled promises can silently swallow errors, leading to data loss or inconsistent state with no diagnostic trail.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST parsing.`,
  tags: ['resilience', 'async', 'promises'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return [];
    return analyzeFileForDetachedPromises(content, filePath);
  },
});