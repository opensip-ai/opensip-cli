/**
 * render-bootstrap-diagnostics — host-owned stderr presentation for command-scoped
 * bootstrap diagnostics (ADR-0060, Phase 5).
 */

import { renderDiagnosticsHuman } from '../ui/render-diagnostic.js';

import type { BootstrapDiagnosticsCollector } from '@opensip-cli/core';

const STDERR_HOST = {
  writeStderr: (text: string) => process.stderr.write(text),
};

/** True when the selected command owns its own bootstrap diagnostic surface. */
export function isDedicatedBootstrapDiagnosticCommand(commandPath: string): boolean {
  return commandPath === 'tools doctor' || commandPath.endsWith(' doctor');
}

/**
 * Render bootstrap diagnostics relevant to the selected command. Unrelated
 * installed-tool health stays silent on normal commands (ADR-0060).
 */
export function renderRelevantBootstrapDiagnostics(
  collector: BootstrapDiagnosticsCollector | undefined,
  toolId: string,
): void {
  if (collector === undefined) return;
  const relevant = collector.filterForCommand(toolId);
  if (relevant.length > 0) {
    renderDiagnosticsHuman(relevant, STDERR_HOST);
  }
}
