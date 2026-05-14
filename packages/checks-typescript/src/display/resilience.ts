/**
 * @fileoverview Display entries for TypeScript-specific resilience checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Resilience check display entries (TS_AST only) */
export const RESILIENCE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'await-result-unwrap': ['⚡', 'Await Result Unwrap'],
  'context-leakage': ['🔍', 'Context Leakage'],
  'context-mutation-check': ['🔍', 'Context Mutation Safety Check'],
  'detached-promises': ['🔗', 'Detached Promises Detection'],
  'no-raw-fetch': ['🌐', 'No Raw Fetch'],
  'no-unbounded-concurrency': ['⚡', 'No Unbounded Concurrency'],
})
