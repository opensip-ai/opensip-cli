/**
 * BootstrapDiagnosticsCollector — the scope-owned buffer for {@link CliDiagnostic}s
 * gathered during bootstrap discovery/load (ADR-0060, Phase 2).
 *
 * Per-invocation state: the host records typed diagnostics as loaders and
 * discovery legs run, then filters the buffer to diagnostics relevant to the
 * selected command before rendering. Unrelated installed-tool health stays
 * silent on normal commands and surfaces on dedicated doctor/list surfaces.
 *
 * ADR-0176: outcome assembly projects this buffer into the lifecycle
 * {@link RunDiagnostics} plane (see {@link mergeBootstrapIntoRunDiagnostics}) so
 * `--json` consumers see bootstrap capability/policy diagnostics with
 * `data.origin: 'bootstrap'`.
 */

import type { CliDiagnostic } from './cli-diagnostic.js';
import type {
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticPhase,
  RunDiagnostics,
} from './run-diagnostics.js';

/** Origin stamp for projected bootstrap events on the outcome plane (ADR-0176). */
export const BOOTSTRAP_DIAGNOSTIC_ORIGIN = 'bootstrap' as const;

/** Whether a buffered diagnostic is relevant to the selected command surface. */
export function isRelevantDiagnostic(
  diagnostic: CliDiagnostic,
  toolId?: string,
  capabilityDomain?: string,
): boolean {
  const provenance = diagnostic.provenance;
  if (provenance === undefined) return true;
  if (toolId !== undefined) {
    if (provenance.toolId === toolId) return true;
    if (provenance.packageName === toolId) return true;
  }
  if (capabilityDomain !== undefined && provenance.capabilityDomain === capabilityDomain) {
    return true;
  }
  return false;
}

/**
 * Project one typed bootstrap {@link CliDiagnostic} into a lifecycle
 * {@link DiagnosticEvent} for the outcome diagnostics plane (ADR-0176).
 * Severity maps to level; `discovery` category → `discover` phase, else `load`.
 * `data.origin` is always {@link BOOTSTRAP_DIAGNOSTIC_ORIGIN}.
 */
export function cliDiagnosticToEvent(
  diagnostic: CliDiagnostic,
  at: string = new Date().toISOString(),
): DiagnosticEvent {
  const level: DiagnosticLevel = diagnostic.severity === 'error' ? 'error' : 'warn';
  const phase: DiagnosticPhase = diagnostic.category === 'discovery' ? 'discover' : 'load';
  const data: Record<string, unknown> = {
    origin: BOOTSTRAP_DIAGNOSTIC_ORIGIN,
    code: diagnostic.code,
    category: diagnostic.category,
    impact: diagnostic.impact,
  };
  if (diagnostic.action !== undefined) data.action = diagnostic.action;
  if (diagnostic.detail !== undefined) data.detail = diagnostic.detail;
  if (diagnostic.logRef !== undefined) data.logRef = diagnostic.logRef;
  if (diagnostic.provenance !== undefined) data.provenance = diagnostic.provenance;
  return {
    phase,
    level,
    message: diagnostic.message,
    at,
    data,
  };
}

/**
 * Dual-read merge: lifecycle bus snapshot + bootstrap buffer → one
 * {@link RunDiagnostics} for `CommandOutcome.diagnostics` (ADR-0176). Bootstrap
 * events are ordered **before** lifecycle events (bootstrap precedes execute).
 * Does not mutate either source collector.
 */
export function mergeBootstrapIntoRunDiagnostics(
  base: RunDiagnostics,
  bootstrap: readonly CliDiagnostic[],
  at?: string,
): RunDiagnostics {
  if (bootstrap.length === 0) return base;
  const bootstrapEvents = bootstrap.map((d) =>
    at === undefined ? cliDiagnosticToEvent(d) : cliDiagnosticToEvent(d, at),
  );
  return {
    ...base,
    events: [...bootstrapEvents, ...base.events],
  };
}

/**
 * The per-invocation bootstrap diagnostics collector. Construct one per bootstrap
 * scope (alongside the existing {@link DiagnosticsBus} lifecycle stream).
 */
export class BootstrapDiagnosticsCollector {
  private readonly diagnostics: CliDiagnostic[] = [];

  /** Append one typed diagnostic. Cheap — safe to call from any bootstrap leg. */
  record(diagnostic: CliDiagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  /** Snapshot the full buffered stream (unfiltered). */
  list(): readonly CliDiagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * Return diagnostics relevant to the selected command. Global diagnostics
   * (no provenance) always pass; tool- or domain-scoped diagnostics pass only when
   * their provenance matches the supplied filter. With no filter args, every
   * buffered diagnostic is returned (doctor / `tools list` surfaces).
   */
  filterForCommand(toolId?: string, capabilityDomain?: string): readonly CliDiagnostic[] {
    if (toolId === undefined && capabilityDomain === undefined) {
      return this.list();
    }
    return this.diagnostics.filter((d) => isRelevantDiagnostic(d, toolId, capabilityDomain));
  }
}
