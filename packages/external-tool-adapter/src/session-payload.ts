/**
 * @fileoverview Adapter-owned session payload (ADR-0090; ADR-0011 session split).
 *
 * The host persists each adapter run's session row with an OPAQUE, tool-owned
 * detail blob (`session_tool_payload.payload`). The dashboard's shared
 * session-detail renderer groups `payload.checks[]` and computes
 * `clean = errors === 0 && warnings === 0` from `payload.summary`. An adapter
 * session that carried only a finding COUNT (no `checks`/`summary`) therefore
 * rendered a secret/vuln scan as "No findings — this run was clean. Every rule
 * passed" — actively misleading. This builder gives adapters the SAME
 * rule-grouped detail shape graph and fitness own (`buildGraphSessionPayload` /
 * `buildFitnessSessionPayload`), derived straight from the run's already-redacted,
 * provenance-stamped `Signal[]`.
 *
 * Layer-legal: pure and substrate-local (no `cli`/datastore import — the host
 * writes the row). The shape is tool-owned and opaque to `contracts`, exactly
 * like graph/fitness own theirs.
 *
 * SECRET HYGIENE: every field here is copied from a signal that was redacted at
 * INGEST (e.g. the gitleaks parser masks `Secret` to a non-reversible preview and
 * never reads `Match`). No raw credential reaches this payload — and `metadata`
 * is narrowed to JSON scalars, dropping the nested provenance object entirely.
 * Proven by the substrate unit suite and each adapter's worker E2E.
 */

import { isErrorSignal } from '@opensip-cli/core';

import type { Signal, SignalRepair } from '@opensip-cli/core';

/** Two-level severity the dashboard buckets on (`critical|high → error`). */
export type AdapterFindingSeverity = 'error' | 'warning';

/** JSON-safe scalar — the metadata-value subset the persisted shape permits. */
export type JsonScalar = string | number | boolean;

/** A persisted finding row — the structural subset the dashboard renders. */
export interface AdapterSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: AdapterFindingSeverity;
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  readonly metadata?: Readonly<Record<string, JsonScalar>>;
  /** Structured repair guidance (ADR-0086) — round-trips through replay. */
  readonly repair?: SignalRepair;
}

/** A persisted per-rule detail row — the structural subset the dashboard renders. */
export interface AdapterSessionCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly findings: readonly AdapterSessionFinding[];
  readonly durationMs: number;
}

/**
 * Opaque-to-contracts detail blob written for every adapter session. `checks` is
 * the scanner's findings grouped by `ruleId` (one row per rule that fired); the
 * dashboard's shared session-detail renderer reads `summary` and `checks`
 * structurally.
 */
export interface AdapterSessionPayload {
  /** Inner version per the payload schema evolution convention (v1 shape). */
  readonly __version: 1;
  readonly summary: {
    /** Rules that fired (one `checks[]` row each). */
    readonly total: number;
    /** Rules with no error-severity finding. */
    readonly passed: number;
    /** Rules with ≥1 error-severity finding. */
    readonly failed: number;
    /** Error-severity (critical|high) finding count. */
    readonly errors: number;
    /** Warning-severity (medium|low) finding count. */
    readonly warnings: number;
  };
  readonly checks: readonly AdapterSessionCheck[];
}

/**
 * Narrow a signal's open `metadata` bag to the JSON-safe scalar subset the
 * persisted shape permits (string | number | boolean). Nested objects (e.g. the
 * stamped `provenance`) are dropped. Returns undefined when nothing survives.
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

/** Map one redacted signal to its persisted finding row (2-level severity bucket). */
function toSessionFinding(s: Signal): AdapterSessionFinding {
  const metadata = projectMetadata(s.metadata);
  return {
    ruleId: s.ruleId,
    message: s.message,
    severity: isErrorSignal(s) ? 'error' : 'warning',
    filePath: s.filePath,
    ...(s.line === undefined ? {} : { line: s.line }),
    ...(s.column === undefined ? {} : { column: s.column }),
    ...(s.suggestion === undefined ? {} : { suggestion: s.suggestion }),
    ...(metadata ? { metadata } : {}),
    ...(s.repair === undefined ? {} : { repair: s.repair }),
  };
}

/** Group findings by `ruleId` into one `checks[]` row per rule (fit/graph semantics). */
function groupByRule(signals: readonly Signal[]): AdapterSessionCheck[] {
  const byRule = new Map<string, AdapterSessionFinding[]>();
  for (const s of signals) {
    const arr = byRule.get(s.ruleId);
    if (arr) arr.push(toSessionFinding(s));
    else byRule.set(s.ruleId, [toSessionFinding(s)]);
  }
  return [...byRule].map(([checkSlug, findings]) => ({
    checkSlug,
    passed: findings.every((f) => f.severity !== 'error'),
    violationCount: findings.length,
    findings,
    // Per-rule `durationMs` is 0 — a scanner reports one wall-clock duration for the
    // whole run (carried separately on the session payload), not per rule, exactly
    // as graph does for its rule groups.
    durationMs: 0,
  }));
}

/**
 * Build the adapter session payload directly from the run's redacted `Signal[]`.
 *
 * Groups by `ruleId` into the dashboard's rule-grouped detail (`checks[]`),
 * collapsing the 4-level signal severity to the dashboard's two-level
 * `error`/`warning` bucket. Per-rule `passed` follows fit/graph semantics
 * (warnings alone do not fail a rule).
 */
export function buildAdapterSessionPayload(signals: readonly Signal[]): AdapterSessionPayload {
  const checks = groupByRule(signals);
  const errors = signals.filter(isErrorSignal).length;
  const warnings = signals.length - errors;

  return {
    __version: 1,
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
