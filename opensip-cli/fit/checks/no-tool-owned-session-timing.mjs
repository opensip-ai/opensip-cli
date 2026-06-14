/**
 * @fileoverview no-tool-owned-session-timing
 *               (slug: architecture-session-timing-not-host-owned) —
 *               first-party (and third-party) tools must not capture or pass
 *               their own `new Date()` / `Date.now()` / `performance.now()`
 *               values for the generic `StoredSession.timestamp` / `durationMs`
 *               columns. Project-local SELF-check for opensip-cli.
 *
 * Relocated out of `@opensip-cli/checks-universal`: this check encodes
 * opensip-cli's OWN persistence architecture (ADR-0048 host-owned run timing).
 * Its persist-surface hints (`persistFitSession`, `saveGraphSession`,
 * `runSession`, `SessionRepo`, …) and the `ToolCliContext.runSession` + RunTimer
 * seam it points authors at are opensip-internal facts — an adopter who installs
 * opensip-cli and runs `fit` on their own code has none of them, so the rule is
 * inert there. Per opensip-cli/fit/checks/README.md, such "local facts" checks
 * live HERE as a dogfood self-check, not in the shipped pack
 * (enforced by `shipped-checks-must-be-generic`).
 *
 * The host (`ToolCliContext.runSession` + `RunTimer`) is the sole source for the
 * generic session row. Internal per-unit / per-stage / recipe makespan timers
 * are allowed and encouraged for diagnostics (they go into the tool-owned
 * payload or collectReportData, not the generic session row).
 *
 * Intentionally a simple text scan so it can be kept in sync with the persist
 * surface as tools evolve. Run as part of normal `fit` / `fit:ci` (dogfood gate)
 * so regressions are caught on PRs.
 */
import { defineCheck } from '@opensip-cli/fitness';

const ANTI_PATTERNS = [/new\s+Date\s*\(/, /Date\.now\s*\(/, /performance\.now\s*\(/];

const PERSIST_HINTS = [
  'persistFitSession',
  'persistSimSession',
  'persistSession',
  'saveGraphSession',
  'persistWorkspaceSession',
  'SessionRepo',
  'runSession',
];

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeNoToolOwnedSessionTiming(content) {
  const violations = [];
  const hasPersistHint = PERSIST_HINTS.some((h) => content.includes(h));
  if (!hasPersistHint) return violations;

  // If the file touches a persist surface, any Date.now/new Date in it is suspect
  // for session timing (we err on the side of reporting; authors can
  // @fitness-ignore-file if the Date is for a legitimate internal timer that does
  // *not* feed StoredSession).
  for (const pat of ANTI_PATTERNS) {
    if (pat.test(content)) {
      // Find a rough line for the report (first match).
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
}

export const checks = [
  defineCheck({
    id: 'f8e4c2a1-9b3d-4e7f-8a1c-2d5e6f7a8b9c', // stable uuid (preserved on relocation)
    slug: 'architecture-session-timing-not-host-owned',
    description:
      'Tools must not capture Date/performance values for StoredSession timing fields. The host RunTimer + runSession.record seam is the only allowed source.',
    scope: { languages: ['universal'], concerns: ['backend'] },
    tags: ['architecture', 'timing'],
    analyze: (content) => analyzeNoToolOwnedSessionTiming(content),
  }),
];
