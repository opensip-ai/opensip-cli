/**
 * bootstrap-diagnostics-buffer — per-process buffer for bootstrap {@link CliDiagnostic}s
 * gathered before a {@link RunScope} exists (ADR-0060, Phase 3/5).
 *
 * Discovery and startup legs record here; the composition root transfers the
 * snapshot onto the per-run scope in `buildPerRunScope`.
 */

import { BootstrapDiagnosticsCollector, type CliDiagnostic } from '@opensip-cli/core';

export { createStartupTimer, type StartupTimingEvent } from './startup-timing.js';

let buffer: BootstrapDiagnosticsCollector | undefined;

/** Reset and return a fresh bootstrap diagnostics buffer (call once per bootstrap). */
export function resetBootstrapDiagnosticsBuffer(): BootstrapDiagnosticsCollector {
  buffer = new BootstrapDiagnosticsCollector();
  return buffer;
}

/** The active bootstrap buffer, lazily created when callers record outside bootstrap. */
export function getBootstrapDiagnosticsBuffer(): BootstrapDiagnosticsCollector {
  buffer ??= new BootstrapDiagnosticsCollector();
  return buffer;
}

/** Snapshot every diagnostic buffered during startup discovery/load. */
export function takeBootstrapDiagnostics(): readonly CliDiagnostic[] {
  return getBootstrapDiagnosticsBuffer().list();
}
