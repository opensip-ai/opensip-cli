/* eslint-disable sonarjs/fixme-tag -- this file's documentation references the FIXME marker by design */
// @fitness-ignore-file no-todo-comments -- this file's job is to detect FIXME/HACK workaround markers; the words appear in JSDoc by design
/**
 * @fileoverview Detects temporary-workaround comments.
 *
 * Catches `HACK`/`FIXME` lines that explicitly describe themselves
 * as `temporary`, a `workaround`, or "before launch" — these
 * announcements are signs that a permanent fix was deferred.
 *
 * Extracted from the former `no-legacy-code` umbrella in Phase C4.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const EXCLUDE_PATTERNS = [/fitness/, /test/, /spec/, /docs/, /reports/, /versioning/];

function shouldExcludeFile(relativePath: string): boolean {
  return EXCLUDE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

const MARKER_NEEDLES = ['hack', 'fixme'] as const;
const QUALIFIER_NEEDLES = ['before launch', 'temporary', 'workaround'] as const;

function matchTemporaryWorkaround(line: string): boolean {
  const lower = line.toLowerCase();
  if (!MARKER_NEEDLES.some((m) => lower.includes(m))) return false;
  return QUALIFIER_NEEDLES.some((q) => lower.includes(q));
}

export const noTemporaryWorkarounds = defineCheck({
  id: '09a93ec8-7b08-47b2-946a-c635e135b67b',
  slug: 'no-temporary-workarounds',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  confidence: 'medium',
  description: 'Detects HACK/FIXME comments that describe themselves as temporary',
  longDescription: `**Purpose:** Flags \`HACK\`/\`FIXME\` comments that explicitly mark themselves as temporary, "before launch", or workarounds. These announcements are reliable signals that a permanent fix was deferred.

**Detects:**
- Lines containing \`HACK\` or \`FIXME\` *and* one of \`temporary\`, \`workaround\`, \`before launch\`

**Why it matters:** Temporary workarounds outlive their context. Surfacing them on every fitness run keeps the conversation about the permanent fix open.

**Scope:** General best practice. Analyzes each file individually; excludes test/docs/versioning paths.`,
  tags: ['code-quality', 'compliance', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze(content, filePath): CheckViolation[] {
    if (shouldExcludeFile(filePath)) return [];

    const lower = content.toLowerCase();
    const hasMarker = MARKER_NEEDLES.some((m) => lower.includes(m));
    if (!hasMarker) return [];

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [i, line] of lines.entries()) {
      if (!line) continue;
      if (matchTemporaryWorkaround(line)) {
        violations.push({
          line: i + 1,
          column: 0,
          message: 'Found temporary workaround - implement permanent solution before launch',
          severity: 'error',
          type: 'temporary-workaround',
          suggestion: 'Replace temporary workaround with a permanent, production-ready solution',
          match: line.trim(),
        });
      }
    }

    return violations;
  },
});
