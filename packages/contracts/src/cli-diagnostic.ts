/**
 * CliDiagnostic — the typed bootstrap/setup diagnostic currency (ADR-0060).
 *
 * DEFINED in @opensip-cli/core (beside the scope-owned collector that produces
 * it; core cannot import contracts); re-exported here so `CommandOutcome` and
 * machine consumers can name the shape on the public contracts facade.
 */

export type {
  CliDiagnostic,
  CliDiagnosticCategory,
  CliDiagnosticCode,
  CliDiagnosticProvenance,
  CliDiagnosticSeverity,
} from '@opensip-cli/core';

export { CLI_DIAGNOSTIC_CODES } from '@opensip-cli/core';