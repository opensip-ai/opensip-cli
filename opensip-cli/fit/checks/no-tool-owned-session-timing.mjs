/**
 * @fileoverview no-tool-owned-session-timing
 *               (slug: architecture-session-timing-not-host-owned) —
 *               first-party TOOL code (fitness / simulation / graph engines)
 *               must not touch the generic-session PERSISTENCE surface. The host
 *               run plane owns the `StoredSession` row and its
 *               `startedAt`/`completedAt`/`durationMs` (stamped from the single
 *               `RunTimer`); tools return a `ToolSessionContribution`
 *               (`ToolRunCompletion.session`) and the host persists it.
 *               Project-local SELF-check for opensip-cli (ADR-0051).
 *
 * Why local: the persist surface (`SessionRepo`, the removed `persist*Session`
 * helpers, the removed `runSession.record(...)` seam) and the host RunTimer are
 * opensip-internal facts — an adopter who installs opensip-cli and runs `fit` on
 * their own code has none of them, so the rule is inert there. Per
 * opensip-cli/fit/checks/README.md such "local facts" checks live HERE as a
 * dogfood self-check, not in the shipped pack (enforced by
 * `shipped-checks-must-be-generic`).
 *
 * SCOPE (path-gated): only first-party TOOL engine/adapter packages
 * (`packages/{fitness,simulation,graph}/…`), excluding tests. The HOST run plane
 * (`packages/cli/src/bootstrap/run-plane.ts`), the RunTimer
 * (`packages/core/src/lib/run-timer.ts`) and the persistence layer
 * (`packages/session-store/…`) are the sanctioned owners — they are not under a
 * tool package, so they are allowed BY PATH (this replaces the former blanket
 * `@fitness-ignore-file` on run-plane.ts; spec Phase 7 §7.1).
 *
 * WHAT IT FORBIDS (precise symbols, not innocent clocks): a tool file must not
 * reference `SessionRepo`, any `persist*Session` helper, or `runSession.record`.
 * These are the only ways a tool could own the generic row, and they are exact
 * identifiers — so the check needs no Date/`performance.now` heuristic. That
 * heuristic was deliberately DROPPED: after Phase 3 (helpers removed) + Phase 6
 * (record seam removed) a tool has no sanctioned path to feed generic timing, so
 * every remaining `new Date()` / `Date.now()` / `performance.now()` in tool code
 * is an internal per-unit/stage timer or a SignalEnvelope `createdAt`/duration —
 * all legitimate and tool-owned (they belong in the payload / envelope, never
 * the generic row). Flagging them produced only false positives, so the precise
 * symbol scan is the root-cause signal. Read helpers (`resolveSession`,
 * `decodeSessionPayload`) are NOT forbidden — replaying a stored session is fine.
 *
 * Comments/JSDoc are stripped before scanning so a doc reference to a removed
 * seam (e.g. "the host persists what `runSession.record` used to") never trips
 * the gate — only real code does. Run as part of normal `fit` / `fit:ci`.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Path prefixes of first-party TOOL packages this check governs. */
const TOOL_PACKAGE_MARKERS = ['packages/fitness/', 'packages/simulation/', 'packages/graph/'];

/**
 * Generic-session PERSISTENCE symbols only the HOST may reference. Exact
 * identifiers (not substrings of innocent calls): `SessionRepo` is the writer
 * class; the `persist*Session` names are the Phase-3-removed helpers (kept as a
 * re-introduction guard); `runSession.record` is the Phase-6-removed launch seam.
 */
const FORBIDDEN_PERSIST_SYMBOLS = [
  'SessionRepo',
  'persistFitSession',
  'persistSimSession',
  'persistSession',
  'saveGraphSession',
  'persistWorkspaceSession',
  'runSession.record',
];

/** True for a first-party tool engine/adapter SOURCE file (not a test/dist). */
function isFirstPartyToolProdFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const norm = filePath.replaceAll('\\', '/');
  if (
    norm.includes('/__tests__/') ||
    norm.includes('/test-support') ||
    norm.includes('/dist/') ||
    /\.test\.[cm]?tsx?$/.test(norm)
  ) {
    return false;
  }
  return TOOL_PACKAGE_MARKERS.some((marker) => norm.includes(marker));
}

/** Strip block + line comments (URL-safe) so doc references don't trip the gate. */
function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Pure analysis. Flags any forbidden generic-session persistence symbol that
 * appears in real (comment-stripped) code under a first-party tool package.
 * Exported for direct exercise by the check's unit test.
 */
export function analyzeNoToolOwnedSessionTiming(content, filePath) {
  const violations = [];
  if (!isFirstPartyToolProdFile(filePath)) return violations;

  const code = stripComments(content);
  const lines = code.split('\n');
  for (const symbol of FORBIDDEN_PERSIST_SYMBOLS) {
    if (!code.includes(symbol)) continue;
    const lineIdx = lines.findIndex((l) => l.includes(symbol));
    violations.push({
      severity: 'error',
      message:
        `First-party tool code must not touch the generic-session persistence surface ('${symbol}'). ` +
        'Return a ToolSessionContribution (ToolRunCompletion.session) from your command handler / live ' +
        'renderer — the host run plane stamps startedAt/completedAt/durationMs from the single RunTimer ' +
        'and persists the StoredSession row. Internal per-unit/stage timers and SignalEnvelope timing ' +
        'are tool-owned and belong in the payload/envelope, never the generic row.',
      line: lineIdx >= 0 ? lineIdx + 1 : 1,
      column: 0,
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'f8e4c2a1-9b3d-4e7f-8a1c-2d5e6f7a8b9c', // stable uuid (preserved across rewrites)
    slug: 'architecture-session-timing-not-host-owned',
    description:
      'First-party tool code must not reference the generic-session persistence surface (SessionRepo / persist*Session / runSession.record). Tools return a ToolSessionContribution; the host RunTimer + run plane own the StoredSession row and its timing.',
    scope: { languages: [], concerns: [] }, // any TS; pinned via checkOverrides → all-ts
    tags: ['architecture', 'timing'],
    analyze: (content, filePath) => analyzeNoToolOwnedSessionTiming(content, filePath),
  }),
];
