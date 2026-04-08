/**
 * @fileoverview Display entries for security and testing checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Security check display entries */
export const SECURITY_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'api-key-rotation': ['\uD83D\uDD10', 'API Key Rotation'],
  'auth-middleware-coverage': ['\uD83D\uDD10', 'Auth Middleware Coverage'],
  'auth-route-guard': ['\uD83D\uDD10', 'Auth Route Guard'],
  'cors-configuration': ['\uD83D\uDD12', 'CORS Configuration'],
  'csp-headers': ['\uD83D\uDD12', 'CSP Headers'],
  'env-secret-exposure': ['\uD83D\uDD10', 'Env Secret Exposure'],
  'input-sanitization': ['\uD83D\uDEE1\uFE0F', 'Input Sanitization'],
  'jwt-validation': ['\uD83D\uDD10', 'JWT Validation'],
  'no-eval': ['\uD83D\uDD12', 'No Eval'],
  'no-hardcoded-secrets': ['\uD83D\uDD10', 'No Hardcoded Secrets'],
  'pii-logging': ['\uD83D\uDD12', 'PII Logging'],
  'rate-limit-coverage': ['\uD83D\uDEE1\uFE0F', 'Rate Limit Coverage'],
  'semgrep-scan': ['\uD83D\uDD0D', 'Semgrep Security Scan'],
  'sql-injection': ['\uD83D\uDD12', 'SQL Injection'],
  'use-centralized-crypto': ['\uD83D\uDD10', 'Centralized Crypto Usage'],
  'webhook-signature-verification': ['\uD83D\uDD10', 'Webhook Signature Verification'],
  'hasura-production-config': ['\uD83D\uDD12', 'Hasura Production Config'],
  'unsafe-secret-comparison': ['\uD83D\uDD10', 'Unsafe Secret Comparison'],
})

/** Testing check display entries */
export const TESTING_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'mock-implementations-in-production': ['\uD83C\uDFAD', 'Mock Implementations in Production'],
  'no-focused-tests': ['\uD83E\uDDEA', 'No Focused Tests'],
  'no-skipped-tests': ['\uD83E\uDDEA', 'No Skipped Tests'],
  'no-test-only-skip': ['\uD83E\uDDEA', 'No Test-Only Skip'],
  'test-file-naming': ['\uD83E\uDDEA', 'Test File Naming'],
  'test-file-pairing': ['\uD83E\uDDEA', 'Test File Existence Check'],
  'no-stub-tests': ['\uD83E\uDDEA', 'No Stub Tests'],
  'test-convention-consistency': ['\uD83E\uDDEA', 'Test Convention Consistency'],
})
