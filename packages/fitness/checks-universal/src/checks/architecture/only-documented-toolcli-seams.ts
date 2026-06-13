/**
 * @fileoverview Host command handlers and tool engines must only use the
 * documented seams on ToolCliContext (and its hostPlanes bag).
 *
 * This is the static enforcement half of the "only documented seams" rule
 * from the host-planes-scope-seams-hygiene plan (Phases 3-4).
 *
 * After the hygiene:
 * - Every production path runs inside an entered RunScope (pre-action or
 *   explicit runWithScope in tests).
 * - The single sanctioned currency for output, delivery, SARIF, baselines,
 *   tool-owned state, and the host governance/audit/entitlements planes is the
 *   ToolCliContext passed to every tool action body and host command handler.
 *   Canonical methods: render, emitJson, emitEnvelope, deliverSignals,
 *   writeSarif, plus the baseline seams, toolState, and hostPlanes (when present).
 *
 * Direct process.stdout (run output), console.* for run data, the old
 * pre-scope CliRuntimeContext holder (getCurrentRegistriesForScope etc. — now
 * test-only), or raw DataStore construction / .db access from command bodies
 * bypass the contract (ADR-0011, entered-scope invariant, host-owned planes).
 *
 * SCOPE: tool engines (fitness/graph/simulation/engine/src) + CLI host command
 * handlers (packages/cli/src/commands). The composition root (bootstrap/*,
 * cli-context the builder, error/report seams, registration sites) legitimately
 * own the final sinks or construct the context — they are exempted by path guard.
 *
 * LEGITIMATE exceptions (subprocess IPC, early bootstrap, tests) use the
 * `@fitness-ignore-file only-documented-toolcli-seams` directive with a
 * justification, exactly like the older no-direct-stdout-in-tool-engine check.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Paths that are tool engines or host command handlers (the code that must go through seams). */
const ENFORCED_PATH = /packages\/(fitness|graph|simulation)\/engine\/src\/|packages\/cli\/src\/commands\//;

/** Bootstrap / composition root that are allowed to touch the low-level seams or build contexts. */
const BOOTSTRAP_EXEMPT = /packages\/cli\/src\/(bootstrap|cli-context|error-handler|report|index|welcome|ui)\//;

/**
 * Bad call shapes for run output.
 */
const STDOUT_PATTERNS: readonly RegExp[] = [
  /\bprocess\.stdout\.write\s*\(/,
  /\bconsole\.(?:log|info|debug)\s*\(/,
];

/**
 * Pre-scope holder symbols (test-only or bootstrap-internal after Phase 3).
 */
const HOLDER_PATTERNS: readonly RegExp[] = [
  /\bgetCurrentRegistriesForScope\s*\(/,
  /\bmarkScopeEntered\s*\(/,
  /\bsetCurrentRunScope\s*\(/,
  /\bcurrentRuntimeContext\b/,
];

/**
 * Raw datastore construction or direct .db access outside the persistence layer.
 * Complements the existing "restrict-raw-db-access" check; this one focuses on
 * command/handler bodies reaching it.
 */
const RAW_DS_PATTERNS: readonly RegExp[] = [
  /\bnew DataStoreFactory\b/,
  /\bDataStoreFactory\.open\b/,
  // .db is internal; reaching it from non-datastore code is the smell
  /\b\.db\b/,
];

export function analyzeOnlyDocumentedSeams(content: string, filePath: string): CheckViolation[] {
  if (!ENFORCED_PATH.test(filePath)) return [];
  if (BOOTSTRAP_EXEMPT.test(filePath)) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');

  const push = (i: number, message: string, suggestion: string) => {
    violations.push({ message, severity: 'error', line: i + 1, suggestion });
  };

  for (const [i, line] of lines.entries()) {
    for (const p of STDOUT_PATTERNS) {
      if (p.test(line)) {
        push(
          i,
          'Host command handlers and tool engines must emit via ToolCliContext seams only (render, emitJson, emitEnvelope, deliverSignals, writeSarif, baseline seams, toolState, hostPlanes). Direct stdout bypasses the output contract and entered-scope invariant.',
          'Route through the ToolCliContext you received, or add `@fitness-ignore-file only-documented-toolcli-seams` with justification if this is deliberate bootstrap/subprocess IPC.'
        );
        break;
      }
    }
    for (const p of HOLDER_PATTERNS) {
      if (p.test(line)) {
        push(
          i,
          'The pre-scope holder (getCurrentRegistriesForScope, markScopeEntered, setCurrentRunScope, currentRuntimeContext) is test-only after hygiene Phase 3. Production code (handlers, engines) must use currentScope() after a proper enterScope and the blessed methods on ToolCliContext.',
          'Remove the holder access; the context you receive already carries everything via the entered scope.'
        );
        break;
      }
    }
    for (const p of RAW_DS_PATTERNS) {
      if (p.test(line)) {
        push(
          i,
          'Raw DataStore construction or direct .db access from command handlers or tool engines is forbidden. Use the datastore thunk on the entered RunScope (scope.datastore()) or the toolState / baseline / hostPlanes seams on ToolCliContext.',
          'Obtain the datastore via currentScope().datastore() (or the ctx provided to you); raw access belongs only in @opensip-cli/datastore and its immediate host-owned consumers.'
        );
        break;
      }
    }
  }
  return violations;
}

export const onlyDocumentedToolcliSeams = defineCheck({
  id: '7f3c2a1b-8e9d-4f0a-9c1d-2e3f4a5b6c7d',
  slug: 'only-documented-toolcli-seams',
  description:
    'Host command handlers and tool engines must only use the documented methods on ToolCliContext (render, emit*, deliverSignals, writeSarif, toolState, hostPlanes, baseline seams). No direct stdout, pre-scope holder, or raw datastore (host-planes hygiene).',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings',
  analyze: (content, filePath) => analyzeOnlyDocumentedSeams(content, filePath),
});
