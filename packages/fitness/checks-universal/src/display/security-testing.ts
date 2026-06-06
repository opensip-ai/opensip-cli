/**
 * @fileoverview Display entries for cross-language security and testing checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Security check display entries (UNIVERSAL only) */
export const SECURITY_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'api-key-rotation': ['🔐', 'API Key Rotation'],
  'auth-middleware-coverage': ['🔐', 'Auth Middleware Coverage'],
  'auth-route-guard': ['🔐', 'Auth Route Guard'],
  'cors-configuration': ['🔒', 'CORS Configuration'],
  'csp-headers': ['🔒', 'CSP Headers'],
  'dependency-vulnerability-audit': ['🔒', 'Dependency Vulnerability Audit'],
  'env-secret-exposure': ['🔐', 'Env Secret Exposure'],
  'hasura-production-config': ['🔒', 'Hasura Production Config'],
  'jwt-validation': ['🔐', 'JWT Validation'],
  'no-eval': ['🔒', 'No Eval'],
  'no-hardcoded-secrets': ['🔐', 'No Hardcoded Secrets'],
  'package-supply-chain-policy': ['🔒', 'Package Supply Chain Policy'],
  'pii-logging': ['🔒', 'PII Logging'],
  'rate-limit-coverage': ['🛡️', 'Rate Limit Coverage'],
  'semgrep-scan': ['🔍', 'Semgrep Security Scan'],
  'use-centralized-crypto': ['🔐', 'Centralized Crypto Usage'],
  'webhook-signature-verification': ['🔐', 'Webhook Signature Verification'],
})

/** Testing check display entries (UNIVERSAL only) */
export const TESTING_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'no-focused-tests': ['🧪', 'No Focused Tests'],
  'no-skipped-tests': ['🧪', 'No Skipped Tests'],
  'no-stub-tests': ['🧪', 'No Stub Tests'],
  'test-convention-consistency': ['🧪', 'Test Convention Consistency'],
  'test-file-naming': ['🧪', 'Test File Naming'],
  'test-file-pairing': ['🧪', 'Test File Existence Check'],
})
