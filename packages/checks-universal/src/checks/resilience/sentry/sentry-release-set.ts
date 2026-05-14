/**
 * @fileoverview Detect Sentry.init() without release option
 * @module checks-builtin/checks/resilience/sentry/sentry-release-set
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

import { hasSentryInit, extractSentryInitBlock } from './sentry-helpers.js'

function analyze(content: string, _filePath: string): CheckViolation[] {
  if (!hasSentryInit(content)) return []

  const initBlock = extractSentryInitBlock(content)
  if (!initBlock) return []

  const hasRelease =
    initBlock.block.includes('release') ||
    initBlock.block.includes('SENTRY_RELEASE')

  if (hasRelease) return []

  return [
    {
      line: initBlock.startLine + 1,
      message:
        'Sentry.init() called without release — cannot link errors to deploys or commits',
      severity: 'warning',
      suggestion:
        'Add release to Sentry.init(): Sentry.init({ release: process.env.SENTRY_RELEASE || "1.0.0", ... }). Pair with @sentry/webpack-plugin or @sentry/vite-plugin for automatic release creation.',
      type: 'sentry-missing-release',
    },
  ]
}

/**
 * Check: sentry-release-set
 *
 * Detects Sentry.init() calls missing the release option.
 * Without it, Sentry can't track regressions across deploys.
 */
export const sentryReleaseSet = defineCheck({
  id: 'c3e9a5b2-6d4f-4a0c-b123-f5e7c9d1a4b6',
  slug: 'sentry-release-set',
  scope: { languages: ['typescript', 'javascript'], concerns: ['backend', 'frontend'] },
  description: 'Detects Sentry.init() without release — cannot track regressions across deploys',
  longDescription: `**Purpose:** Ensures Sentry events include a release identifier so errors can be correlated with specific deploys and commits.

**Detects:**
- \`Sentry.init()\` calls with no \`release\` property

**Why it matters:** The release field enables Sentry's most powerful features: regression detection (new errors in this release), deploy tracking, commit association, and suspect commits. Without it, Sentry treats all errors as if they come from the same undifferentiated codebase.

**Scope:** Any file that calls \`Sentry.init()\`. Analyzes each file individually.`,
  tags: ['sentry', 'quality', 'observability'],
  fileTypes: ['ts', 'js', 'tsx', 'jsx', 'mjs'],
  confidence: 'high',
  analyze,
})
