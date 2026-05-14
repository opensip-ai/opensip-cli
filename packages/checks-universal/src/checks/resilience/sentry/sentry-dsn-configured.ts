/**
 * @fileoverview Detect Sentry.init() calls without a DSN configured
 * @module checks-builtin/checks/resilience/sentry/sentry-dsn-configured
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

import { hasSentryInit, extractSentryInitBlock } from './sentry-helpers.js'

function analyze(content: string, _filePath: string): CheckViolation[] {
  if (!hasSentryInit(content)) return []

  const initBlock = extractSentryInitBlock(content)
  if (!initBlock) return []

  // Check if DSN is present in the init block
  const hasDsn =
    initBlock.block.includes('dsn') ||
    initBlock.block.includes('DSN') ||
    initBlock.block.includes('SENTRY_DSN')

  if (hasDsn) return []

  return [
    {
      line: initBlock.startLine + 1,
      message:
        'Sentry.init() called without a DSN — Sentry will not report errors without a valid DSN',
      severity: 'error',
      suggestion:
        'Add a dsn property to Sentry.init(): Sentry.init({ dsn: process.env.SENTRY_DSN, ... })',
      type: 'sentry-missing-dsn',
    },
  ]
}

/**
 * Check: sentry-dsn-configured
 *
 * Detects Sentry.init() calls that are missing a DSN.
 * Without a DSN, the Sentry SDK silently drops all events — monitoring is dead.
 */
export const sentryDsnConfigured = defineCheck({
  id: 'a1c7e3f0-4b2d-4e8a-9f01-d3c5a7b9e2f4',
  slug: 'sentry-dsn-configured',
  scope: { languages: ['typescript', 'javascript'], concerns: ['backend', 'frontend'] },
  description: 'Detects Sentry.init() without a DSN — monitoring silently disabled',
  longDescription: `**Purpose:** Ensures Sentry is actually configured to report errors by checking that a DSN is provided in the init call.

**Detects:**
- \`Sentry.init({})\` or \`Sentry.init({ integrations: [...] })\` with no \`dsn\` property
- Init calls that configure everything except the DSN

**Why it matters:** Without a DSN, the Sentry SDK initializes without error but silently drops all events. This is one of the most common Sentry misconfigurations — the app appears to have monitoring but nothing is actually being reported.

**Scope:** Any file that calls \`Sentry.init()\`. Analyzes each file individually.`,
  tags: ['sentry', 'resilience', 'observability'],
  fileTypes: ['ts', 'js', 'tsx', 'jsx', 'mjs'],
  confidence: 'high',
  analyze,
})
