// @fitness-ignore-file no-window-alert -- Fitness check definition references window.alert/confirm/prompt in string literals and regex patterns, not actual usage
/**
 * @fileoverview No window.alert/confirm/prompt Check
 *
 * Detects usage of window.alert(), window.confirm(), and window.prompt()
 * in frontend code. These native browser dialogs provide poor UX and
 * should be replaced with modal components or toast notifications.
 *
 * Migrated to defineRegexListCheck (Layer 4 Phase C6). The original
 * site's `break // Only report once per line` is preserved via the
 * helper's `oneViolationPerLine: true` option, and the import-skip is
 * preserved via `skipLine`.
 */

import { defineRegexListCheck } from '@opensip-tools/fitness'

/**
 * Check: quality/no-window-alert
 *
 * Prevents usage of native browser dialogs in frontend code.
 */
export const noWindowAlert = defineRegexListCheck({
  id: '170b156b-a45d-4f1a-af7a-a40ed507afe0',
  slug: 'no-window-alert',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'strip-strings',
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
  options: {
    // Original site skipped lines starting with `import ` (defensive
    // against lines like `import { alert } from "..."`).
    skipLine: (trimmed) => trimmed.startsWith('import '),
    // Original site `break`s after the first matching pattern to emit
    // only one violation per line.
    oneViolationPerLine: true,
  },
  patterns: [
    {
      id: 'aa11e90a-65b6-4e6c-9b62-9d3f0fae4b2a',
      slug: 'window-alert',
      regex: /window\.alert\s*\(/,
      message: 'window.alert() provides poor UX — replace with a proper UI component',
      severity: 'error',
      suggestion: 'Use a toast notification or modal dialog instead of window.alert()',
    },
    {
      id: 'bb22e90a-65b6-4e6c-9b62-9d3f0fae4b2b',
      slug: 'window-confirm',
      regex: /window\.confirm\s*\(/,
      message: 'window.confirm() provides poor UX — replace with a proper UI component',
      severity: 'error',
      suggestion: 'Use a confirmation modal dialog instead of window.confirm()',
    },
    {
      id: 'cc33e90a-65b6-4e6c-9b62-9d3f0fae4b2c',
      slug: 'window-prompt',
      regex: /window\.prompt\s*\(/,
      message: 'window.prompt() provides poor UX — replace with a proper UI component',
      severity: 'error',
      suggestion: 'Use a form input in a modal dialog instead of window.prompt()',
    },
  ],
})
