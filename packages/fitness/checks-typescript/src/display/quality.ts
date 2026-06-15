/**
 * @fileoverview Display entries for TypeScript-specific quality checks
 */

import type { CheckDisplayEntry } from './types.js';

/** Quality check display entries (TS_AST only, sorted alphabetically by slug) */
export const QUALITY_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'a11y-form-labels': ['♿', 'A11y Form Labels'],
  'a11y-semantic-html': ['♿', 'A11y Semantic HTML'],
  'api-contract-validation': ['🔌', 'API Contract Validation'],
  'api-response-validation': ['🔌', 'API Response Validation'],
  'array-validation': ['📦', 'Array Parameter Validation'],
  'async-waterfall-detection': ['⚡', 'Async Waterfall Detection'],
  'database-index-coverage': ['🗄️', 'Database Index Coverage'],
  'database-schema-validation': ['🗄️', 'Database Schema Validation'],
  'dispose-pattern-completeness': ['🧹', 'Dispose Pattern Completeness'],
  'duplicate-utility-functions': ['🔍', 'Duplicate Utility Functions'],
  'error-handling-quality': ['⚠️', 'Error Handling Quality'],
  'fastify-route-validation': ['🔌', 'Fastify Route Validation'],
  'fastify-schema-coverage': ['🔌', 'Fastify Schema Coverage'],
  'in-memory-repository-detection': ['💾', 'In-Memory Repository Detection'],
  'incomplete-regex-escaping': ['🔒', 'Incomplete Regex Escaping'],
  'lifecycle-cleanup-enforcement': ['🧹', 'Lifecycle Cleanup Enforcement'],
  'logger-event-name-format': ['📊', 'Logger Event Name Format'],
  'missing-input-validation': ['🛡️', 'Missing Input Validation'],
  'no-any-types': ['📘', 'No Any Types'],
  'no-hardcoded-correlation-id': ['🔗', 'No Hardcoded Correlation Id'],
  'null-safety': ['🛡️', 'Null/Undefined Safety'],
  'numeric-validation': ['🔢', 'Numeric Parameter Validation'],
  'pii-exposure-in-logs': ['🔒', 'PII Exposure in Logs'],
  'result-pattern-consistency': ['📋', 'Result Pattern Consistency'],
  'silent-early-returns': ['🔍', 'Silent Early Returns'],
  'stream-buffer-size-limits': ['🛡️', 'Stream Buffer Size Limits'],
  'stubbed-implementation-detection': ['🔍', 'Stubbed Implementation Detection'],
  'test-only-frontend-modules': ['🧪', 'Test-Only Frontend Modules'],
  'throws-documentation': ['📝', 'Missing @throws JSDoc Detection'],
  'toctou-race-condition': ['⚡', 'TOCTOU Race Condition Detection'],
  'typescript-frontend': ['📘', 'TypeScript Frontend'],
  'unused-config-options': ['⚙️', 'Unused Configuration Options'],
});
