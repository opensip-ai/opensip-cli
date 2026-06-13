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

import { defineRegexListCheck } from '@opensip-cli/fitness';

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
      id: '7a0f6bc1-f4dd-4e55-9628-d797c877c6e0',
      slug: 'window-alert',
      regex: /window\.alert\s*\(/,
      message: 'window.alert() provides poor UX — replace with a proper UI component',
      severity: 'error',
      suggestion: 'Use a toast notification or modal dialog instead of window.alert()',
    },
    {
      id: '09a93ec8-7b08-47b2-946a-c635e135b67b',
      slug: 'window-confirm',
      regex: /window\.confirm\s*\(/,
      message: 'window.confirm() provides poor UX — replace with a proper UI component',
      severity: 'error',
      suggestion: 'Use a confirmation modal dialog instead of window.confirm()',
    },
    {
      id: 'e39edca8-ee4d-4de8-9a39-655f4d0eb86d',
      slug: 'window-prompt',
      regex: /window\.prompt\s*\(/,
      message: 'window.prompt() provides poor UX — replace with a proper UI component',
      severity: 'error',
      suggestion: 'Use a form input in a modal dialog instead of window.prompt()',
    },
  ],
});
