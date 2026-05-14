/**
 * @fileoverview Detect Sentry.init() without environment option
 * @module checks-builtin/checks/resilience/sentry/sentry-environment-set
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

import { hasSentryInit, extractSentryInitBlock } from './sentry-helpers.js'

function analyze(content: string, _filePath: string): CheckViolation[] {
  if (!hasSentryInit(content)) return []

  const initBlock = extractSentryInitBlock(content)
  if (!initBlock) return []

  const hasEnvironment =
    initBlock.block.includes('environment') ||
    initBlock.block.includes('SENTRY_ENVIRONMENT')

  if (hasEnvironment) return []

  return [
    {
      line: initBlock.startLine + 1,
      message:
        'Sentry.init() called without environment — production and staging errors will be mixed together',
      severity: 'warning',
      suggestion:
        'Add environment to Sentry.init(): Sentry.init({ environment: process.env.NODE_ENV, ... })',
      type: 'sentry-missing-environment',
    },
  ]
}

/**
 * Check: sentry-environment-set
 *
 * Detects Sentry.init() calls missing the environment option.
 * Without it, errors from all environments appear in one stream.
 */
export const sentryEnvironmentSet = defineCheck({
  id: 'b2d8f4a1-5c3e-4f9b-a012-e4d6b8c0f3a5',
  slug: 'sentry-environment-set',
  scope: { languages: ['typescript', 'javascript'], concerns: ['backend', 'frontend'] },
  description: 'Detects Sentry.init() without environment — errors from all environments mixed',
  longDescription: `**Purpose:** Ensures Sentry events are tagged with the deployment environment so errors can be filtered and triaged correctly.

**Detects:**
- \`Sentry.init()\` calls with no \`environment\` property

**Why it matters:** Without an environment tag, production errors are mixed with staging and development noise. This makes issue triage significantly harder and can mask real production incidents behind a flood of non-production events.

**Scope:** Any file that calls \`Sentry.init()\`. Analyzes each file individually.`,
  tags: ['sentry', 'resilience', 'observability'],
  fileTypes: ['ts', 'js', 'tsx', 'jsx', 'mjs'],
  confidence: 'high',
  analyze,
})
