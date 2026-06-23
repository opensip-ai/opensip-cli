/**
 * BootstrapDiagnosticsCollector — the scope-owned buffer for {@link CliDiagnostic}s
 * gathered during bootstrap discovery/load (ADR-0060, Phase 2).
 *
 * Per-invocation state: the host records typed diagnostics as loaders and
 * discovery legs run, then filters the buffer to diagnostics relevant to the
 * selected command before rendering. Unrelated installed-tool health stays
 * silent on normal commands and surfaces on dedicated doctor/list surfaces.
 */

import type { CliDiagnostic } from './cli-diagnostic.js';

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
