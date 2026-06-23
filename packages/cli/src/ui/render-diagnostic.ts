/**
 * render-diagnostic — the host-owned human renderer for {@link CliDiagnostic}s
 * (ADR-0060, Phase 2). One standard stderr format for bootstrap/setup
 * diagnostics; detailed raw errors stay in structured logs (`logRef`).
 */

import type { CliDiagnostic } from '@opensip-cli/contracts';

/** Host seam for stderr delivery — keeps the renderer testable without Ink. */
export interface DiagnosticRenderHost {
  readonly writeStderr: (text: string) => void;
}

const SEVERITY_LABEL: Record<CliDiagnostic['severity'], string> = {
  error: 'error',
  warning: 'warning',
};

/**
 * Materialize one diagnostic as the canonical human line + indented detail block.
 */
export function renderDiagnosticHuman(diag: CliDiagnostic): string {
  const lines: string[] = [
    `opensip: ${SEVERITY_LABEL[diag.severity]} [${diag.code}]: ${diag.message}`,
    `  impact: ${diag.impact}`,
  ];
  if (diag.action !== undefined) lines.push(`  action: ${diag.action}`);
  if (diag.logRef !== undefined) lines.push(`  log: ${diag.logRef}`);
  return lines.join('\n');
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