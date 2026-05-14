/**
 * @fileoverview Detect missing or dangerous tracesSampleRate in Sentry.init()
 * @module checks-builtin/checks/resilience/sentry/sentry-sample-rate
 */

import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/core'

import { hasSentryInit, extractSentryInitBlock } from './sentry-helpers.js'

function analyze(content: string, filePath: string): CheckViolation[] {
  if (!hasSentryInit(content)) return []

  const initBlock = extractSentryInitBlock(content)
  if (!initBlock) return []

  const violations: CheckViolation[] = []

  // Check for tracesSampleRate: 1.0 (or 1) — expensive in production
  const rateMatch = initBlock.block.match(/tracesSampleRate\s*:\s*([\d.]+)/)
  if (rateMatch) {
    const rate = parseFloat(rateMatch[1] ?? '0')
    if (rate === 1 || rate === 1.0) {
      const rateIndex = initBlock.block.indexOf('tracesSampleRate')
      const absoluteIndex = content.indexOf('tracesSampleRate', content.indexOf('Sentry.init'))
      violations.push({
        line: absoluteIndex !== -1 ? getLineNumber(content, absoluteIndex) : initBlock.startLine + 1,
        message:
          'tracesSampleRate is 1.0 — every transaction is traced, which is expensive at scale',
        severity: 'warning',
        suggestion:
          'Set tracesSampleRate to a lower value in production (e.g., 0.1 for 10% sampling). Use environment checks: tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0',
        type: 'sentry-full-sample-rate',
        match: rateMatch[0],
        filePath,
      })
    }
  }

  // Check for missing tracesSampleRate entirely
  if (!initBlock.block.includes('tracesSampleRate') && !initBlock.block.includes('tracesSampler')) {
    // Only flag if the project appears to use Sentry tracing (has performance imports)
    const hasTracingImport =
      content.includes('BrowserTracing') ||
      content.includes('browserTracingIntegration') ||
      content.includes('@sentry/tracing') ||
      content.includes('httpIntegration') ||
      content.includes('expressIntegration')

    if (hasTracingImport) {
      violations.push({
        line: initBlock.startLine + 1,
        message:
          'Sentry tracing integration imported but no tracesSampleRate or tracesSampler set — tracing may be silently disabled',
        severity: 'warning',
        suggestion:
          'Add tracesSampleRate to Sentry.init(): Sentry.init({ tracesSampleRate: 0.1, ... }). Without it, the default is 0 (no traces captured).',
        type: 'sentry-missing-sample-rate',
        filePath,
      })
    }
  }

  return violations
}

/**
 * Check: sentry-sample-rate
 *
 * Detects missing or problematic tracesSampleRate in Sentry.init().
 * Catches both "too high" (1.0 in production) and "not set" (tracing silently off).
 */
export const sentrySampleRate = defineCheck({
  id: 'a7c3e9f6-0b8d-4e4a-f567-d9c1a3b5e8f0',
  slug: 'sentry-sample-rate',
  scope: { languages: ['typescript', 'javascript'], concerns: ['backend', 'frontend'] },
  description: 'Detects missing or 1.0 tracesSampleRate — tracing disabled or too expensive',
  longDescription: `**Purpose:** Ensures Sentry performance tracing is configured with an appropriate sample rate.

**Detects:**
- \`tracesSampleRate: 1.0\` — capturing every transaction is expensive at scale and can significantly increase Sentry costs
- Tracing integrations imported (BrowserTracing, @sentry/tracing, etc.) but no \`tracesSampleRate\` or \`tracesSampler\` configured — tracing defaults to 0 (disabled)

**Why it matters:** A sample rate of 1.0 in production sends every transaction to Sentry, which can be prohibitively expensive and may cause rate limiting. Conversely, importing tracing integrations without setting a sample rate means tracing is silently disabled — the integration runs but captures nothing.

**Scope:** Any file that calls \`Sentry.init()\`. Analyzes each file individually.`,
  tags: ['sentry', 'resilience', 'performance', 'observability'],
  fileTypes: ['ts', 'js', 'tsx', 'jsx', 'mjs'],
  confidence: 'high',
  analyze,
})
