// @fitness-ignore-file no-window-alert -- Fitness check definition references window.alert/confirm/prompt in string literals and regex patterns, not actual usage
/**
 * @fileoverview No window.alert/confirm/prompt Check
 *
 * Detects usage of window.alert(), window.confirm(), and window.prompt()
 * in frontend code. These native browser dialogs provide poor UX and
 * should be replaced with modal components or toast notifications.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

// =============================================================================
// DETECTION
// =============================================================================

const WINDOW_DIALOG_PATTERNS = [
  {
    regex: /window\.alert\s*\(/,
    method: 'window.alert()',
    suggestion: 'Use a toast notification or modal dialog instead of window.alert()',
  },
  {
    regex: /window\.confirm\s*\(/,
    method: 'window.confirm()',
    suggestion: 'Use a confirmation modal dialog instead of window.confirm()',
  },
  {
    regex: /window\.prompt\s*\(/,
    method: 'window.prompt()',
    suggestion: 'Use a form input in a modal dialog instead of window.prompt()',
  },
]

/**
 * Analyze a single file for window dialog usage.
 */
function analyzeFile(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    // Skip comments and imports
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ')) {
      continue
    }

    for (const { regex, method, suggestion } of WINDOW_DIALOG_PATTERNS) {
      if (regex.test(line)) {
        violations.push({
          type: 'window-dialog-usage',
          line: i + 1,
          message: `${method} provides poor UX — replace with a proper UI component`,
          severity: 'error',
          suggestion,
          match: trimmed.slice(0, 120),
        })
        break // Only report once per line
      }
    }
  }

  return violations
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/no-window-alert
 *
 * Prevents usage of native browser dialogs in frontend code.
 */
export const noWindowAlert = defineCheck({
  id: '170b156b-a45d-4f1a-af7a-a40ed507afe0',
  slug: 'no-window-alert',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'code-only',

  confidence: 'medium',
  description:
    'Disallows window.alert(), window.confirm(), and window.prompt() — use proper UI components',
  longDescription: `**Purpose:** Prevents usage of native browser dialog APIs in frontend code, enforcing proper UI components instead.

**Detects:**
- \`window.alert()\` calls -- should use toast notifications or modal dialogs
- \`window.confirm()\` calls -- should use confirmation modal dialogs
- \`window.prompt()\` calls -- should use form inputs in modal dialogs

**Why it matters:** Native browser dialogs block the main thread, cannot be styled, and provide a jarring, inconsistent user experience compared to in-app UI components.

**Scope:** General best practice. Analyzes each file individually (\`analyze\`). Targets frontend files (preset: \`frontend\`), excluding tests.`,
  tags: ['frontend', 'ux', 'quality', 'best-practices'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
