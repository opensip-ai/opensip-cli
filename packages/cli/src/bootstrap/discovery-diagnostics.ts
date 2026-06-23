/**
 * discovery-diagnostics — typed {@link CliDiagnostic} builders for installed-tool
 * discovery legs (ADR-0060, Phase 3).
 */

import {
  CLI_DIAGNOSTIC_CODES,
  classifyModuleError,
  scrubModuleNotFoundMessage,
  type BootstrapDiagnosticsCollector,
  type CliDiagnostic,
  type CliDiagnosticProvenance,
} from '@opensip-cli/core';

import { getBootstrapDiagnosticsBuffer } from './bootstrap-diagnostics-buffer.js';
import { INSTALLED_TOOL_ALLOWLIST_ENV } from './tool-trust.js';

import type { ToolRuntimeLoad } from './admit-tool-package.js';

function record(
  collector: BootstrapDiagnosticsCollector | undefined,
  diagnostic: CliDiagnostic,
): CliDiagnostic {
  (collector ?? getBootstrapDiagnosticsBuffer()).record(diagnostic);
  return diagnostic;
}

/** Manifest read failed for a discovered installed package. */
export function recordInstalledManifestInvalid(
  packageName: string,
  collector?: BootstrapDiagnosticsCollector,
): CliDiagnostic {
  return record(collector, {
    severity: 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID,
    category: 'discovery',
    message: `Tool package ${packageName} has no conformant package.json#opensipTools manifest.`,
    impact: 'The package was skipped and its commands are not available.',
    provenance: { packageName, discoverySource: 'installed' },
  });
}

/** Installed tool blocked by the deny-by-default trust gate. */
export function recordInstalledTrustDenied(
  toolId: string,
  packageName: string,
  packageDir: string,
  collector?: BootstrapDiagnosticsCollector,
): CliDiagnostic {
  return record(collector, {
    severity: 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_TRUST_DENIED,
    category: 'discovery',
    message:
      `Installed tool ${packageName} (${toolId}) is not trusted to load (deny-by-default). ` +
      `Allowlist it via ${INSTALLED_TOOL_ALLOWLIST_ENV}='${toolId}' to admit it ` +
      `(or ${INSTALLED_TOOL_ALLOWLIST_ENV}='*' for all).`,
    impact: 'The package was skipped and its commands are not available.',
    action:
      'See opensip.ai/docs/opensip-cli/70-reference/10-environment-variables/ for trust configuration.',
    provenance: { toolId, packageName, discoverySource: 'installed' },
    detail: packageDir,
  });
}

/** Runtime import/shape failure for an admitted installed package. */
export function recordInstalledLoadFailure(
  name: string,
  load: Extract<ToolRuntimeLoad, { ok: false }>,
  collector?: BootstrapDiagnosticsCollector,
): CliDiagnostic {
  const provenance: CliDiagnosticProvenance = {
    packageName: name,
    discoverySource: 'installed',
  };
  if (load.reason === 'no-entry') {
    return record(collector, {
      severity: 'warning',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED,
      category: 'discovery',
      message: `Tool package ${name} has no resolvable entry point.`,
      impact: 'The package was skipped and its commands are not available.',
      provenance,
    });
  }
  if (load.reason === 'invalid-shape') {
    return record(collector, {
      severity: 'warning',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED,
      category: 'discovery',
      message: `Tool package ${name} does not export a valid \`tool\`.`,
      impact: 'The package was skipped and its commands are not available.',
      provenance,
    });
  }
  const rawDetail = load.detail ?? 'import failed';
  const classified = classifyModuleError(new Error(rawDetail), provenance);
  return record(collector, {
    severity: 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED,
    category: 'discovery',
    message: `Failed to load tool ${name}: ${scrubModuleNotFoundMessage(rawDetail)}.`,
    impact: 'The package was skipped and its commands are not available.',
    provenance,
    detail: classified.detail,
  });
}

/** Unexpected throw while registering a discovered installed package. */
export function recordInstalledCatchFailure(
  packageName: string,
  message: string,
  collector?: BootstrapDiagnosticsCollector,
): CliDiagnostic {
  const provenance: CliDiagnosticProvenance = {
    packageName,
    discoverySource: 'installed',
  };
  const classified = classifyModuleError(new Error(message), provenance);
  return record(collector, {
    severity: 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED,
    category: 'discovery',
    message: `Failed to load tool ${packageName}: ${scrubModuleNotFoundMessage(message)}.`,
    impact: 'The package was skipped and its commands are not available.',
    provenance,
    detail: classified.detail,
  });
}
