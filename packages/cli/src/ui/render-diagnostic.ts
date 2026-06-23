/**
 * render-diagnostic — the host-owned human renderer for {@link CliDiagnostic}s
 * (ADR-0060, Phase 2). One standard stderr format for bootstrap/setup
 * diagnostics; detailed raw errors stay in structured logs (`logRef`).
 */

import { formatCliDiagnosticHuman } from '@opensip-cli/core';

import type { CliDiagnostic } from '@opensip-cli/contracts';

/** Host seam for stderr delivery — keeps the renderer testable without Ink. */
export interface DiagnosticRenderHost {
  readonly writeStderr: (text: string) => void;
}

/**
 * Materialize one diagnostic as the canonical human line + indented detail block.
 */
export function renderDiagnosticHuman(diag: CliDiagnostic): string {
  return formatCliDiagnosticHuman(diag);
}

/**
 * Render buffered diagnostics to stderr through the supplied host only — the one
 * sanctioned human presentation seam for bootstrap diagnostics.
 */
export function renderDiagnosticsHuman(
  diags: readonly CliDiagnostic[],
  host: DiagnosticRenderHost,
): void {
  for (const diag of diags) {
    host.writeStderr(`${renderDiagnosticHuman(diag)}\n`);
  }
}
