/**
 * ARCHITECTURE.SESSION.TIMING_NOT_HOST_OWNED
 *
 * First-party (and third-party) tools must not capture or pass their own
 * `new Date()` / `Date.now()` / `performance.now()` values for the generic
 * `StoredSession.timestamp` or `durationMs` columns.
 *
 * The host (`ToolCliContext.runSession` + `RunTimer`) is the sole source.
 * Internal per-unit / per-stage / recipe makespan timers are allowed and
 * encouraged for diagnostics (they go into the tool-owned payload or
 * collectReportData, not the generic session row).
 *
 * This check is intentionally simple (text scan) so it can be kept in sync
 * with the persist surface as tools evolve. It is run as part of normal `fit`
 * / `fit:ci` (dogfood gate) so regressions are caught on PRs.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const ANTI_PATTERNS = [
  /new\s+Date\s*\(/,
  /Date\.now\s*\(/,
  /performance\.now\s*\(/,
];

const PERSIST_HINTS = [
  'persistFitSession',
  'persistSimSession',
  'persistSession',
  'saveGraphSession',
  'persistWorkspaceSession',
  'SessionRepo',
  'runSession',
];

export const noToolOwnedSessionTiming = defineCheck({
  id: 'f8e4c2a1-9b3d-4e7f-8a1c-2d5e6f7a8b9c', // stable uuid per ADR-0048 style
  slug: 'architecture-session-timing-not-host-owned',
  description:
    'Tools must not capture Date/performance values for StoredSession timing fields. The host RunTimer + runSession.record seam is the only allowed source.',
  scope: { languages: ['universal'], concerns: ['backend'] },
  tags: ['architecture', 'timing'],
  analyze(content, filePath) {
    const violations: CheckViolation[] = [];
    const hasPersistHint = PERSIST_HINTS.some((h) => content.includes(h));
    if (!hasPersistHint) return violations;

    // If the file touches a persist surface, any Date.now/new Date in it is suspect
    // for session timing (we err on the side of reporting; authors can @fitness-ignore-file
    // if the Date is for a legitimate internal timer that does *not* feed StoredSession).
    for (const pat of ANTI_PATTERNS) {
      if (pat.test(content)) {
        // Find a rough line for the report (first match)
        const lines = content.split('\n');
        const lineIdx = lines.findIndex((l) => pat.test(l));
        violations.push({
          severity: 'error',
          message:
            'Direct wall-clock capture for StoredSession timing is forbidden. Use the host `cli.runSession.timing` (RunTimer) and `record(...)` seam only. Internal diagnostic timers are allowed but must not populate the generic `timestamp`/`durationMs` columns.',
          line: lineIdx >= 0 ? lineIdx + 1 : 1,
          column: 0,
        });
        break;
      }
    }
    return violations;
  },
});
