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
 * pre-scope CliRuntimeContext holder (getCurrentRegistriesForScope /
 * setCliRuntimeContextForRun / getToolProvenanceForRun etc. — now REMOVED;
 * these patterns are a reintroduction tripwire), or raw DataStore
 * *construction* (`new DataStoreFactory` / `DataStoreFactory.open`) from command
 * bodies bypass the contract (ADR-0011, entered-scope invariant, host-owned
 * planes).
 *
 * RAW `.db` QUERY ACCESS IS DELEGATED, NOT DUPLICATED: confining the raw Drizzle
 * handle (`DataStore.db.select(...)` etc.) to the persistence ownership boundary
 * is the job of the purpose-built `restrict-raw-db-access` check, which already
 * does it correctly — it skips test fixtures and the `/src/persistence/`,
 * `session-store`, and `datastore` boundaries, and requires a real Drizzle
 * query call-shape (not a bare `.db` token). This check does NOT re-police raw
 * `.db`; it would only re-flag, more crudely, what that sibling already gates
 * (and false-fire on persistence-owned repositories and test fixtures). This
 * check owns the concern its sibling does not: a handler/engine *constructing* a
 * datastore directly instead of reading `scope.datastore()`.
 *
 * SCOPE: tool engines (fitness/graph/simulation/engine/src) + CLI host command
 * handlers (packages/cli/src/commands). The composition root (bootstrap/*,
 * cli-context the builder, error/report seams, registration sites) legitimately
 * own the final sinks or construct the context — they are exempted by path guard.
 * Test files are skipped (fixtures legitimately exercise these shapes), matching
 * the sibling `restrict-raw-db-access` / `one-outcome-shape` posture.
 *
 * LEGITIMATE exceptions (subprocess IPC, early bootstrap) use the
 * `@fitness-ignore-file only-documented-toolcli-seams` directive with a
 * justification, exactly like the older no-direct-stdout-in-tool-engine check.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/** Paths that are tool engines or host command handlers (the code that must go through seams). */
const ENFORCED_PATH =
  /packages\/(fitness|graph|simulation)\/engine\/src\/|packages\/cli\/src\/commands\//;

/** Bootstrap / composition root that are allowed to touch the low-level seams or build contexts. */
const BOOTSTRAP_EXEMPT =
  /packages\/cli\/src\/(bootstrap|cli-context|error-handler|report|index|welcome|ui)\//;

/**
 * Test fixtures legitimately construct datastores and reach pre-scope holders to
 * set up scenarios. Skipped wholesale, matching `restrict-raw-db-access` and
 * `one-outcome-shape`.
 */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/**
 * The persistence ownership boundary: a repository here legitimately constructs
 * and holds a datastore. Datastore-construction is not a seam bypass inside it.
 * Mirrors the boundary `restrict-raw-db-access` confines raw `.db` access to.
 */
const PERSISTENCE_BOUNDARY: readonly RegExp[] = [
  /\/src\/persistence\//,
  /packages\/session-store\/src\//,
  /packages\/datastore\/src\//,
];

/**
 * Bad call shapes for run output.
 */
const STDOUT_PATTERNS: readonly RegExp[] = [
  /\bprocess\.stdout\.write\s*\(/,
  /\bconsole\.(?:log|info|debug)\s*\(/,
];

/**
 * Pre-scope handoff-bag symbols. The module-global `currentRuntimeContext` bag
 * and its accessors were REMOVED — per-run registries are captured in the
 * pre-action-hook closure, and the admitted-tool manifests/provenance ride the
 * entered `RunScope` (read via `currentScope()`). These patterns are now a
 * reintroduction tripwire: a handler/engine reaching a (re-added) module-global
 * handoff bag instead of the entered scope is a regression. Call-shaped so prose
 * mentions of the names don't false-fire.
 */
const HOLDER_PATTERNS: readonly RegExp[] = [
  /\bgetCurrentRegistriesForScope\s*\(/,
  /\bsetCliRuntimeContextForRun\s*\(/,
  /\bsetCliRegistriesForRun\s*\(/,
  /\bgetToolProvenanceForRun\s*\(/,
  /\bgetToolManifestsForRun\s*\(/,
  /\bsetToolProvenanceForRun\s*\(/,
  /\bmarkScopeEntered\s*\(/,
  /\bsetCurrentRunScope\s*\(/,
  /\bcurrentRuntimeContext\b/,
];

/**
 * Raw datastore *construction* outside the persistence layer. A handler/engine
 * must read `scope.datastore()`, never stand up its own. Raw `.db` *query*
 * access is deliberately NOT matched here — that is `restrict-raw-db-access`'s
 * boundary-aware concern (see the file header).
 */
const RAW_DS_PATTERNS: readonly RegExp[] = [
  /\bnew DataStoreFactory\b/,
  /\bDataStoreFactory\.open\b/,
];

/** One forbidden-shape rule: any matching pattern on a line is a violation. */
interface SeamRule {
  readonly patterns: readonly RegExp[];
  readonly message: string;
  readonly suggestion: string;
}

const STDOUT_RULE: SeamRule = {
  patterns: STDOUT_PATTERNS,
  message:
    'Host command handlers and tool engines must emit via ToolCliContext seams only (render, emitJson, emitEnvelope, deliverSignals, writeSarif, baseline seams, toolState, hostPlanes). Direct stdout bypasses the output contract and entered-scope invariant.',
  suggestion:
    'Route through the ToolCliContext you received, or add `@fitness-ignore-file only-documented-toolcli-seams` with justification if this is deliberate bootstrap/subprocess IPC.',
};

const HOLDER_RULE: SeamRule = {
  patterns: HOLDER_PATTERNS,
  message:
    'The pre-scope module-global handoff bag (currentRuntimeContext + setCliRuntimeContextForRun / getCurrentRegistriesForScope / getToolProvenanceForRun / getToolManifestsForRun, and the historical markScopeEntered / setCurrentRunScope) was REMOVED. Per-run registries are captured in the pre-action-hook closure; admitted-tool manifests/provenance ride the entered RunScope. Handlers/engines must use currentScope() (or the ToolCliContext) — reintroducing a module-global handoff bag is a regression.',
  suggestion:
    'Read per-run state via currentScope() after enterScope (or the ToolCliContext you receive); do not stand up a module-global handoff bag.',
};

const RAW_DS_RULE: SeamRule = {
  patterns: RAW_DS_PATTERNS,
  message:
    'Raw DataStore construction from command handlers or tool engines is forbidden. Use the datastore thunk on the entered RunScope (scope.datastore()) or the toolState / baseline / hostPlanes seams on ToolCliContext.',
  suggestion:
    'Obtain the datastore via currentScope().datastore() (or the ctx provided to you); constructing a datastore belongs only in @opensip-cli/datastore and its immediate host-owned consumers.',
};

const matchesAny = (patterns: readonly RegExp[], line: string): boolean =>
  patterns.some((p) => p.test(line));

export function analyzeOnlyDocumentedSeams(content: string, filePath: string): CheckViolation[] {
  if (!ENFORCED_PATH.test(filePath)) return [];
  if (BOOTSTRAP_EXEMPT.test(filePath)) return [];
  // Tests legitimately exercise these shapes (fixtures / scenario setup).
  if (TEST_PATH.test(filePath)) return [];

  // Datastore *construction* is a seam bypass only OUTSIDE the persistence
  // ownership boundary (a repository there legitimately stands one up). Raw `.db`
  // query access is governed by restrict-raw-db-access, not re-policed here.
  const rules: readonly SeamRule[] = PERSISTENCE_BOUNDARY.some((re) => re.test(filePath))
    ? [STDOUT_RULE, HOLDER_RULE]
    : [STDOUT_RULE, HOLDER_RULE, RAW_DS_RULE];

  const violations: CheckViolation[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    for (const rule of rules) {
      if (matchesAny(rule.patterns, line)) {
        violations.push({
          message: rule.message,
          suggestion: rule.suggestion,
          severity: 'error',
          line: i + 1,
        });
      }
    }
  }
  return violations;
}

export const onlyDocumentedToolcliSeams = defineCheck({
  id: '1ea47b8c-18be-402b-ae19-8ac66a88d050',
  slug: 'only-documented-toolcli-seams',
  description:
    'Host command handlers and tool engines must only use the documented methods on ToolCliContext (render, emit*, deliverSignals, writeSarif, toolState, hostPlanes, baseline seams). No direct stdout, pre-scope holder, or raw datastore (host-planes hygiene).',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings',
  analyze: (content, filePath) => analyzeOnlyDocumentedSeams(content, filePath),
});
