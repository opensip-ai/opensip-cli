// @fitness-ignore-file sentry-pii-scrubbing -- check definition references beforeSend/beforeBreadcrumb as detection patterns
/**
 * @fileoverview Detect Sentry.init() without PII scrubbing callbacks
 * @module checks-builtin/checks/resilience/sentry/sentry-pii-scrubbing
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

import { hasSentryInit, extractSentryInitBlock } from './sentry-helpers.js'

// PII-sensitive Sentry API calls — setting user context, extras, or tags
// that commonly carry personal data
const PII_CONTEXT_PATTERNS = [
  'setUser(',
  'Sentry.setUser(',
  'setExtra(',
  'Sentry.setExtra(',
  'setContext(',
  'Sentry.setContext(',
]

// Field names that suggest PII in Sentry context calls
const PII_FIELD_NAMES = [
  'email',
  'phone',
  'ip_address',
  'ipAddress',
  'username',
  'name',
  'address',
  'ssn',
  'creditCard',
  'credit_card',
  'password',
  'token',
  'secret',
  'apiKey',
  'api_key',
]

function analyze(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []

  // --- Tier 1: Missing beforeSend/beforeBreadcrumb in Sentry.init (high confidence) ---

  if (hasSentryInit(content)) {
    const initBlock = extractSentryInitBlock(content)
    if (initBlock) {
      const hasBeforeSend = initBlock.block.includes('beforeSend')
      const hasBeforeBreadcrumb = initBlock.block.includes('beforeBreadcrumb')
      const hasBeforeSendTransaction = initBlock.block.includes('beforeSendTransaction')

      if (!hasBeforeSend && !hasBeforeBreadcrumb && !hasBeforeSendTransaction) {
        violations.push({
          line: initBlock.startLine + 1,
          message:
            'Sentry.init() has no beforeSend or beforeBreadcrumb callback — PII may be sent to Sentry unfiltered',
          severity: 'warning',
          suggestion:
            'Add a beforeSend callback to filter sensitive data: Sentry.init({ beforeSend(event) { /* scrub PII */ return event; }, ... })',
          type: 'sentry-no-pii-filter',
          filePath,
        })
      }
    }
  }

  // --- Tier 2: PII field names in Sentry context calls (medium confidence) ---

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    // Check if line has a Sentry context-setting call
    const hasContextCall = PII_CONTEXT_PATTERNS.some((pattern) => line.includes(pattern))
    if (!hasContextCall) continue

    // Check for PII field names in the call
    for (const field of PII_FIELD_NAMES) {
      const fieldIdx = line.indexOf(field)
      if (fieldIdx === -1) continue

      // Verify it looks like a property (followed by : or ,)
      const afterField = line.slice(fieldIdx + field.length).trimStart()
      if (afterField.startsWith(':') || afterField.startsWith(',') || afterField.startsWith('}')) {
        violations.push({
          line: i + 1,
          column: fieldIdx,
          message: `PII field '${field}' passed to Sentry context — may violate GDPR/CCPA`,
          severity: 'warning',
          suggestion: `Scrub or hash the '${field}' field before sending to Sentry. Consider using Sentry's data scrubbing settings or a beforeSend callback.`,
          type: 'sentry-pii-in-context',
          match: trimmed.slice(0, 120),
          filePath,
        })
        break // One violation per line is enough
      }
    }
  }

  return violations
}

/**
 * Check: sentry-pii-scrubbing
 *
 * Two-tier PII detection for Sentry:
 * 1. (High confidence) Sentry.init() without beforeSend/beforeBreadcrumb
 * 2. (Medium confidence) PII field names in Sentry context-setting calls
 */
export const sentryPiiScrubbing = defineCheck({
  id: 'd4f0b6c3-7e5a-4b1d-c234-a6f8d0e2b5c7',
  slug: 'sentry-pii-scrubbing',
  scope: { languages: ['typescript', 'javascript'], concerns: ['backend', 'frontend'] },
  description: 'Detects missing PII scrubbing in Sentry — personal data may leak to third party',
  longDescription: `**Purpose:** Ensures personal data is scrubbed before being sent to Sentry, preventing GDPR/CCPA violations.

**Detects (two tiers):**

*Tier 1 — Missing filter callbacks (high confidence):*
- \`Sentry.init()\` with no \`beforeSend\`, \`beforeBreadcrumb\`, or \`beforeSendTransaction\` callback

*Tier 2 — PII in context calls (medium confidence):*
- \`Sentry.setUser()\`, \`setExtra()\`, \`setContext()\` calls containing field names that suggest PII: email, phone, ip_address, username, name, address, ssn, creditCard, password, token, secret, apiKey

**Why it matters:** Sentry is a third-party service. Any PII sent to it becomes subject to Sentry's data retention policies and expands your compliance surface. A beforeSend callback is the standard defense-in-depth mechanism.

**Scope:** Any file that uses the Sentry SDK. Analyzes each file individually.`,
  tags: ['sentry', 'security', 'pii', 'privacy'],
  fileTypes: ['ts', 'js', 'tsx', 'jsx', 'mjs'],
  confidence: 'medium',
  analyze,
})
