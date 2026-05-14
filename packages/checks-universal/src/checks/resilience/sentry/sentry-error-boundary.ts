/**
 * @fileoverview Detect React + Sentry without ErrorBoundary
 * @module checks-builtin/checks/resilience/sentry/sentry-error-boundary
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

import { hasSentryUsage } from './sentry-helpers.js'

// Sentry error boundary patterns (component or HOC)
const ERROR_BOUNDARY_PATTERNS = [
  'Sentry.ErrorBoundary',
  'withErrorBoundary',
  'Sentry.withErrorBoundary',
  'ErrorBoundary', // Sentry re-export or custom with Sentry wiring
]

function analyze(content: string, filePath: string): CheckViolation[] {
  // Only check React files (JSX/TSX)
  if (!filePath.endsWith('.tsx') && !filePath.endsWith('.jsx')) return []

  // Must use Sentry
  if (!hasSentryUsage(content)) return []

  // Must be a React component file (has JSX return or render)
  const hasJsx = content.includes('return (') || content.includes('return(')
  const hasReactImport = content.includes('react') || content.includes('React')
  if (!hasJsx && !hasReactImport) return []

  // Check if any error boundary pattern is present
  const hasErrorBoundary = ERROR_BOUNDARY_PATTERNS.some((pattern) => content.includes(pattern))
  if (hasErrorBoundary) return []

  // Find the Sentry import line for the violation location
  const lines = content.split('\n')
  let sentryImportLine = 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.includes('@sentry/') || line.includes('Sentry')) {
      sentryImportLine = i + 1
      break
    }
  }

  return [
    {
      line: sentryImportLine,
      message:
        'React component uses Sentry but has no ErrorBoundary — unhandled render errors will crash the app without Sentry capture',
      severity: 'warning',
      suggestion:
        'Wrap key route components with Sentry.ErrorBoundary: <Sentry.ErrorBoundary fallback={<ErrorFallback />}><App /></Sentry.ErrorBoundary>',
      type: 'sentry-missing-error-boundary',
      filePath,
    },
  ]
}

/**
 * Check: sentry-error-boundary
 *
 * Detects React components that import Sentry but don't use
 * Sentry.ErrorBoundary or withErrorBoundary.
 */
export const sentryErrorBoundary = defineCheck({
  id: 'f6b2d8e5-9a7c-4d3f-e456-c8b0f2a4d7e9',
  slug: 'sentry-error-boundary',
  scope: { languages: ['typescript', 'javascript'], concerns: ['frontend'] },
  description: 'Detects React + Sentry without ErrorBoundary — render crashes go unreported',
  longDescription: `**Purpose:** Ensures React applications using Sentry wrap key components with error boundaries to capture render errors.

**Detects:**
- React component files (.tsx/.jsx) that import/use Sentry but contain no \`Sentry.ErrorBoundary\`, \`withErrorBoundary\`, or \`ErrorBoundary\` component

**Why it matters:** React render errors that aren't caught by an error boundary will crash the entire component tree. Without Sentry's ErrorBoundary, these crashes are not reported to Sentry — you lose visibility into the most severe class of frontend errors. Sentry's ErrorBoundary also provides graceful fallback UI.

**Scope:** React component files (.tsx, .jsx) that use the Sentry SDK. Analyzes each file individually.`,
  tags: ['sentry', 'resilience', 'react', 'frontend'],
  fileTypes: ['tsx', 'jsx'],
  confidence: 'medium',
  analyze,
})
