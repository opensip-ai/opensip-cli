/**
 * @fileoverview Timer lifecycle check
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Analyze a file for setInterval without corresponding clearInterval
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Inherent complexity: line-by-line detection of setInterval/clearInterval pairs with variable capture tracking
function analyzeTimerLifecycle(content: string, _filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');

  // Quick check: skip files without setInterval
  if (!content.includes('setInterval')) return violations;

  const intervalCreations: { line: number; varName: string | null }[] = [];
  let hasClearInterval = false;

  for (const [i, line_] of lines.entries()) {
    /* v8 ignore next -- defensive: lines.entries() never yields undefined */
    const line = line_ ?? '';
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Detect setInterval with variable capture
    const intervalMatch = /(?:const|let|var)\s+(\w+)\s*=\s*setInterval\s*\(/.exec(line);
    if (intervalMatch) {
      /* v8 ignore next -- defensive: regex (\w+) capture group always yields a string */
      intervalCreations.push({ line: i + 1, varName: intervalMatch[1] ?? null });
    } else if (/\bsetInterval\s*\(/.test(line) && !line.includes('clearInterval')) {
      // setInterval without variable capture
      intervalCreations.push({ line: i + 1, varName: null });
    }

    // Detect cleanup
    if (/\bclearInterval\s*\(/.test(line)) hasClearInterval = true;
  }

  // Flag intervals without corresponding cleanup
  if (!hasClearInterval) {
    for (const interval of intervalCreations) {
      violations.push({
        line: interval.line,
        // eslint-disable-next-line sonarjs/no-nested-template-literals -- Optional variable name suffix is a single inline expression; clearer than pre-computing
        message: `setInterval() created${interval.varName ? ` (${interval.varName})` : ''} without clearInterval() in the same module — potential timer leak`,
        severity: 'warning',
        suggestion:
          'Store the timer ID and call clearInterval() in a cleanup/dispose/shutdown handler',
        type: 'interval-without-cleanup',
      });
    }
  }

  return violations;
}

/**
 * Check: resilience/timer-lifecycle
 *
 * Detects setInterval() calls without corresponding clearInterval() cleanup.
 */
export const timerLifecycle = defineCheck({
  id: 'f42299e1-6d22-4c4b-a236-6157a95f0949',
  slug: 'timer-lifecycle',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  description:
    'Detects setInterval() calls without corresponding clearInterval() cleanup — prevents timer leaks',
  longDescription: `**Purpose:** Detects \`setInterval()\` calls that have no corresponding \`clearInterval()\` in the same module, which causes timer leaks.

**Detects:**
- \`setInterval()\` calls (with or without variable capture) where no \`clearInterval()\` exists in the same file
- Focuses on \`setInterval\` (always needs cleanup) rather than \`setTimeout\` (often fire-and-forget)

**Why it matters:** Leaked intervals cause memory leaks and can prevent graceful shutdown. They continue executing after their purpose has ended.

**Scope:** Backend code. Analyzes each file individually via regex.`,
  tags: ['resilience', 'memory', 'lifecycle'],
  fileTypes: ['ts'],
  contentFilter: 'strip-strings',
  confidence: 'medium',
  analyze: analyzeTimerLifecycle,
});
