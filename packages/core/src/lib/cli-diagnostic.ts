/**
 * CliDiagnostic — the typed bootstrap/setup diagnostic currency (ADR-0060,
 * Phase 2). Loaders, discovery, and capability registration return these to the
 * host instead of writing user-facing lines to `stderr`; the host renders them
 * through one human format and one JSON shape.
 *
 * DEFINED here (beside the scope-owned {@link BootstrapDiagnosticsCollector}
 * that gathers them; core cannot import contracts). Re-exported by
 * `@opensip-cli/contracts` for `CommandOutcome` and machine consumers.
 *
 * Serialization-safe by construction: every field is a primitive, a plain
 * record, or undefined — no functions, no class instances.
 */

/** Non-fatal vs fail-closed severity for a bootstrap diagnostic. */
export type CliDiagnosticSeverity = 'error' | 'warning';

/**
 * The coarse failure plane — used by renderers and `filterForCommand` to decide
 * whether a buffered diagnostic belongs on the selected command's surface.
 */
export type CliDiagnosticCategory =
  | 'configuration'
  | 'compatibility'
  | 'integrity'
  | 'runtime'
  | 'discovery'
  | 'degraded';

/**
 * Identity join keys stamped by producers so the host can scope bootstrap
 * diagnostics to the selected command without leaking unrelated tool health.
 */
export interface CliDiagnosticProvenance {
  readonly toolId?: string;
  readonly stableId?: string;
  readonly packageName?: string;
  readonly discoverySource?: string;
  readonly capabilityDomain?: string;
}

/**
 * One structured bootstrap diagnostic. `impact` states what the failure means for
 * the run; `action` is an optional remediation hint (human + JSON). Raw loader
 * throws belong in structured logs — surface `logRef` when a detailed trace exists.
 */
export interface CliDiagnostic {
  readonly severity: CliDiagnosticSeverity;
  readonly code: string;
  readonly category: CliDiagnosticCategory;
  readonly message: string;
  readonly impact: string;
  readonly action?: string;
  readonly provenance?: CliDiagnosticProvenance;
  readonly detail?: string;
  readonly logRef?: string;
}

/** Stable machine codes for bootstrap diagnostics (ADR-0060). */
export const CLI_DIAGNOSTIC_CODES = {
  OPENSIP_INTEGRITY_INJECTED_COPY_STALE: 'OPENSIP_INTEGRITY_INJECTED_COPY_STALE',
  OPENSIP_INTEGRITY_MISSING_DIST_ENTRY: 'OPENSIP_INTEGRITY_MISSING_DIST_ENTRY',
  OPENSIP_FIT_EMPTY_CHECK_REGISTRY: 'OPENSIP_FIT_EMPTY_CHECK_REGISTRY',
  OPENSIP_FIT_CHECK_PACK_LOAD_FAILED: 'OPENSIP_FIT_CHECK_PACK_LOAD_FAILED',
  OPENSIP_PLUGIN_LOAD_FAILED: 'OPENSIP_PLUGIN_LOAD_FAILED',
  OPENSIP_DISCOVERY_TOOL_LOAD_FAILED: 'OPENSIP_DISCOVERY_TOOL_LOAD_FAILED',
  OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID: 'OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID',
  OPENSIP_DISCOVERY_TOOL_TRUST_DENIED: 'OPENSIP_DISCOVERY_TOOL_TRUST_DENIED',
  OPENSIP_RUNTIME_MODULE_NOT_FOUND: 'OPENSIP_RUNTIME_MODULE_NOT_FOUND',
  OPENSIP_COMPATIBILITY_MANIFEST_REJECTED: 'OPENSIP_COMPATIBILITY_MANIFEST_REJECTED',
  OPENSIP_CAPABILITY_DOMAIN_LOAD_FAILED: 'OPENSIP_CAPABILITY_DOMAIN_LOAD_FAILED',
} as const;

export type CliDiagnosticCode = (typeof CLI_DIAGNOSTIC_CODES)[keyof typeof CLI_DIAGNOSTIC_CODES];

const SEVERITY_LABEL: Record<CliDiagnosticSeverity, string> = {
  error: 'error',
  warning: 'warning',
};

/** Canonical human stderr block for one diagnostic (ADR-0060 host renderer). */
export function formatCliDiagnosticHuman(diag: CliDiagnostic): string {
  const lines: string[] = [
    `opensip: ${SEVERITY_LABEL[diag.severity]} [${diag.code}]: ${diag.message}`,
    `  impact: ${diag.impact}`,
  ];
  if (diag.action !== undefined) lines.push(`  action: ${diag.action}`);
  if (diag.logRef !== undefined) lines.push(`  log: ${diag.logRef}`);
  return lines.join('\n');
}

/** Stamp `logRef` from the current run id when absent. */
export function withLogRef(diagnostic: CliDiagnostic, runId?: string): CliDiagnostic {
  if (runId === undefined || runId.length === 0 || diagnostic.logRef !== undefined) {
    return diagnostic;
  }
  return { ...diagnostic, logRef: runId };
}
