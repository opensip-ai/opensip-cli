/**
 * Fitness-owned session payload (audit 2026-05-29, session split).
 *
 * `contracts` stores per-session detail as an opaque JSON blob in
 * `session_tool_payload.payload` and holds zero check/finding/summary
 * vocabulary. Fitness owns the shape of its own payload here and ships
 * the dashboard renderer that reads it back. Mirrors the detail that the
 * Fitness dashboard tab renders: a top-line summary plus per-check
 * results and findings.
 */

import type { CliOutput } from '@opensip-tools/contracts';

/** Per-check finding inside a {@link FitnessSessionPayload}. */
interface FitnessSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}

/** Per-check result inside a {@link FitnessSessionPayload}. */
interface FitnessSessionCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly findings: readonly FitnessSessionFinding[];
  readonly durationMs: number;
}

/** Opaque-to-contracts detail blob written for every `fit` session. */
export interface FitnessSessionPayload {
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly checks: readonly FitnessSessionCheck[];
}

/** Build the fitness session payload from a {@link CliOutput}. */
export function buildFitnessSessionPayload(output: CliOutput): FitnessSessionPayload {
  return {
    summary: output.summary,
    checks: output.checks.map((c) => ({
      checkSlug: c.checkSlug,
      passed: c.passed,
      violationCount: c.violationCount,
      findings: c.findings.map((f) => ({
        ruleId: f.ruleId,
        message: f.message,
        severity: f.severity,
        filePath: f.filePath,
        line: f.line,
        column: f.column,
        suggestion: f.suggestion,
      })),
      durationMs: c.durationMs,
    })),
  };
}
