/**
 * `tools doctor` — surface every buffered bootstrap diagnostic (ADR-0060).
 */

import type { CliDiagnostic, ToolsDoctorResult } from '@opensip-cli/contracts';

/** Build the tools doctor inventory from the scope-owned bootstrap buffer. */
export function toolsDoctor(diagnostics: readonly CliDiagnostic[]): ToolsDoctorResult {
  return {
    type: 'tools-doctor',
    diagnostics,
    totalCount: diagnostics.length,
  };
}