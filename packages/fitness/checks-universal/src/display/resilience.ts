/**
 * @fileoverview Display entries for cross-language resilience checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Resilience check display entries (UNIVERSAL only) */
export const RESILIENCE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'batch-operation-limits': ['📦', 'Batch Operation Limits'],
  'cache-ttl-validation': ['💾', 'Cache TTL Validation'],
  'catch-clause-safety': ['⚠️', 'Catch Clause Safety'],
  'dangerous-config-defaults': ['⚠️', 'Dangerous Configuration Defaults'],
  'error-code-registration': ['⚠️', 'Error Code Registration'],
  'event-architecture': ['📨', 'Event Architecture'],
  'event-handler-idempotency': ['📨', 'Event Handler Idempotency'],
  'exit-code-correctness': ['⚠️', 'Exit Code Correctness'],
  'graceful-shutdown': ['🛑', 'Graceful Shutdown'],
  'no-custom-cache': ['💾', 'No Custom Cache'],
  'no-custom-rate-limiter': ['🛡️', 'No Custom Rate Limiter'],
  'no-hardcoded-timeouts': ['⏱️', 'No Hardcoded Timeouts'],
  'no-process-exit-in-finally': ['🛑', 'No Process Exit In Finally'],
  'rate-limiting-coverage': ['🛡️', 'Rate Limiting Coverage'],
  'readline-cleanup': ['🧹', 'Readline Cleanup'],
  'recovery-patterns': ['🔄', 'Recovery Layer Usage'],
  'reentrancy-guard': ['🔒', 'Reentrancy Guard'],
  'retry-config-validation': ['🔄', 'Retry Config Validation'],
  'sentry-dsn-configured': ['🛡️', 'Sentry DSN Configured'],
  'sentry-environment-set': ['🛡️', 'Sentry Environment Set'],
  'sentry-error-boundary': ['🛡️', 'Sentry Error Boundary'],
  'sentry-pii-scrubbing': ['🛡️', 'Sentry PII Scrubbing'],
  'sentry-release-set': ['🛡️', 'Sentry Release Set'],
  'sentry-sample-rate': ['🛡️', 'Sentry Sample Rate'],
  'sentry-source-maps': ['🛡️', 'Sentry Source Maps'],
  'timer-lifecycle': ['⏱️', 'Timer Lifecycle'],
  'transaction-boundary-validation': ['💾', 'Transaction Boundary Validation'],
  'transaction-timeout': ['⏱️', 'Transaction Timeout'],
  'unbounded-memory': ['💾', 'Unbounded Memory Detection'],
})
