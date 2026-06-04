// @fitness-ignore-file batch-operation-limits -- iterates the bounded per-run signal set grouped by rule (rule descriptors registered for a single graph run)
/**
 * Graph-owned session payload (audit 2026-05-29, session split; extended
 * 2026-05-29 to carry per-rule detail for the Code Paths session view;
 * rebuilt from `Signal[]` directly in ADR-0011 Phase 5 — no `CliOutput`).
 *
 * `contracts` stores per-session detail as an opaque JSON blob and holds
 * zero tool vocabulary. Graph owns its own payload shape here, derived
 * straight from the run's `Signal[]`. The Code Paths → Sessions subtab
 * renders a per-rule detail panel, so the payload carries rule-grouped
 * detail (`summary` + `checks[]` of rule-grouped findings).
 *
 * The detail shape (`summary` + `checks[]` of rule-grouped findings) is the
 * dashboard's structural session-detail contract, consumed by the shared
 * `renderDetail` in @opensip-tools/dashboard. These types are graph-local
 * structural mirrors (not the retired `contracts` `CheckOutput`/
 * `FindingOutput`): the dashboard reads `checkSlug`/`passed`/`durationMs` and
 * each finding's `severity`/`message`/`filePath`/`line`/`suggestion`/`metadata`
 * structurally.
 *
 * Rule-ID vocabulary: `checkSlug` is the ENGINE slug (`graph:<rule>`), NOT the
 * OpenSIP-mapped rule ID the envelope/SARIF surfaces use. The dashboard's
 * per-rule metric columns (`RULE_METRIC_COLUMNS`) are keyed on engine slugs,
 * so the session detail stays in engine vocabulary (built upstream of the
 * envelope's Option-A remap).
 */

import type { Signal } from '@opensip-tools/core';

/** Two-level severity the dashboard buckets on (`critical|high → error`). */
export type GraphFindingSeverity = 'error' | 'warning';

/** JSON-safe scalar — the metadata-value subset the persisted shape permits. */
export type JsonScalar = string | number | boolean;

/** A persisted finding row — the structural subset the dashboard renders. */
export interface GraphSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: GraphFindingSeverity;
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  readonly metadata?: Readonly<Record<string, JsonScalar>>;
}

/** A persisted per-rule detail row — the structural subset the dashboard renders. */
export interface GraphSessionCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly findings: readonly GraphSessionFinding[];
  readonly durationMs: number;
}

/**
 * Opaque-to-contracts detail blob written for every `graph` session.
 *
 * `checks` is graph's rule-grouped detail: one entry per engine `ruleId` that
 * emitted ≥1 signal, each carrying its findings. The dashboard's shared
 * session-detail renderer reads `summary` and `checks` structurally.
 */
export interface GraphSessionPayload {
  readonly summary: {
    /** Total rules (checks) that emitted ≥1 signal. */
    readonly total: number;
    /** Rules with no error-severity signal. */
    readonly passed: number;
    /** Rules with ≥1 error-severity signal. */
    readonly failed: number;
    /** Error-severity (critical|high) signal count. */
    readonly errors: number;
    /** Warning-severity (medium|low) signal count. */
    readonly warnings: number;
  };
  readonly checks: readonly GraphSessionCheck[];
}

/**
 * Narrow a signal's open `metadata` bag to the JSON-safe scalar subset the
 * persisted shape permits (string | number | boolean). Returns undefined when
 * nothing survives, so findings without metric metadata stay clean.
 */
function projectMetadata(
  metadata: Record<string, unknown> | undefined,
): Readonly<Record<string, JsonScalar>> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, JsonScalar> = {};
  let any = false;
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Build the graph session payload directly from the run's `Signal[]`.
 *
 * Groups by ENGINE `ruleId` into the dashboard's rule-grouped detail
 * (`checks[]`), collapsing the 4-level signal severity to the dashboard's
 * two-level `error`/`warning` bucket. Per-rule `passed` follows fit's
 * semantics (warnings alone do not fail a rule). Persists the full detail
 * (no cap) — the datastore is a rebuildable local cache.
 *
 * @param signals - the run's raw engine signals.
 * @returns the opaque detail blob persisted for this graph session.
 */
export function buildGraphSessionPayload(
  signals: readonly Signal[],
): GraphSessionPayload {
  const byRule = new Map<string, GraphSessionFinding[]>();
  for (const s of signals) {
    const metadata = projectMetadata(s.metadata);
    const finding: GraphSessionFinding = {
      ruleId: s.ruleId,
      message: s.message,
      severity: s.severity === 'critical' || s.severity === 'high' ? 'error' : 'warning',
      filePath: s.filePath,
      line: s.line,
      column: s.column,
      suggestion: s.suggestion,
      ...(metadata ? { metadata } : {}),
    };
    let arr = byRule.get(s.ruleId);
    if (!arr) {
      arr = [];
      byRule.set(s.ruleId, arr);
    }
    arr.push(finding);
  }

  const checks: GraphSessionCheck[] = [];
  for (const [checkSlug, findings] of byRule) {
    const ruleErrors = findings.filter((f) => f.severity === 'error').length;
    checks.push({
      checkSlug,
      passed: ruleErrors === 0,
      violationCount: findings.length,
      findings,
      durationMs: 0,
    });
  }

  const errors = signals.filter((s) => s.severity === 'critical' || s.severity === 'high').length;
  const warnings = signals.length - errors;

  return {
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.passed).length,
      failed: checks.filter((c) => !c.passed).length,
      errors,
      warnings,
    },
    checks,
  };
}
