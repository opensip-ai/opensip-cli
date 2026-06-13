/**
 * @fileoverview Display entries for TypeScript-specific security and testing checks
 */

import type { CheckDisplayEntry } from './types.js';

/** Security check display entries (TS_AST only) */
export const SECURITY_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'input-sanitization': ['🛡️', 'Input Sanitization'],
  'sql-injection': ['🔒', 'SQL Injection'],
  'unsafe-secret-comparison': ['🔐', 'Unsafe Secret Comparison'],
});

/** Testing check display entries (TS_AST only) */
export const TESTING_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'mock-implementations-in-production': ['🎭', 'Mock Implementations in Production'],
});
