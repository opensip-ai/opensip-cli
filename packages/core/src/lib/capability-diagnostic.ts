/**
 * capability-diagnostic — map capability discovery substrate events to typed
 * {@link CliDiagnostic}s (ADR-0060, Phase 3).
 */

import {
  CLI_DIAGNOSTIC_CODES,
  type CliDiagnostic,
  type CliDiagnosticProvenance,
} from './cli-diagnostic.js';

import type { CapabilityDiscoveryDiagnostic } from '../plugins/capability-discovery.js';

/** Convert one capability discovery diagnostic into a bootstrap {@link CliDiagnostic}. */
export function capabilityDiscoveryToCliDiagnostic(
  diagnostic: CapabilityDiscoveryDiagnostic,
  domainId: string,
  provenance?: CliDiagnosticProvenance,
): CliDiagnostic {
  if (diagnostic.evt === 'capability.discovery.foreign_core') {
    return {
      severity: 'warning',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_CAPABILITY_SCOPE_ABI_MISMATCH,
      category: 'integrity',
      message: diagnostic.message,
      impact: `Capability domain '${domainId}' skipped a pack whose @opensip-cli/core scope ABI differs from this CLI's — loading it would split the run scope.`,
      action:
        "Align the pack's @opensip-cli/core with the running CLI: run a CLI matching the " +
        "project's @opensip-cli/* versions, or update the project (e.g. `pnpm update '@opensip-cli/*'`) " +
        'and rebuild the pack so both sides share one scope ABI.',
      provenance: {
        packageName: diagnostic.packageName,
        capabilityDomain: domainId,
        ...provenance,
      },
      logRef: diagnostic.evt,
    };
  }

  if (diagnostic.evt === 'capability.discovery.package_denied') {
    return {
      severity: 'warning',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_CAPABILITY_PACK_UNTRUSTED,
      category: 'discovery',
      message: diagnostic.message,
      impact: `Capability domain '${domainId}' skipped an untrusted package contribution.`,
      action: 'Allowlist the package in the host capability-pack trust configuration.',
      provenance: {
        packageName: diagnostic.packageName,
        capabilityDomain: domainId,
        ...provenance,
      },
      logRef: diagnostic.evt,
    };
  }

  return {
    severity: 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_CAPABILITY_DOMAIN_LOAD_FAILED,
    category: 'degraded',
    message: diagnostic.message,
    impact: `Capability domain '${domainId}' could not load all contributions.`,
    provenance: {
      packageName: diagnostic.packageName,
      capabilityDomain: domainId,
      ...provenance,
    },
    logRef: diagnostic.evt,
  };
}

/** Typed diagnostic when the fitness check registry ends up empty after load. */
export function fitnessEmptyCheckRegistryDiagnostic(): CliDiagnostic {
  return {
    severity: 'error',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY,
    category: 'configuration',
    message: 'No check packages were loaded.',
    impact: 'A fitness run cannot scan anything until at least one check pack is available.',
    action:
      'Install at least one package declaring the fit-pack marker plus target-domain epoch, ' +
      'or declare plugins.checkPackages in opensip-cli.config.yml.',
    provenance: { toolId: 'fitness', capabilityDomain: 'fit-pack' },
  };
}

/** Typed diagnostic for a fitness plugin import failure. */
export function fitnessPluginLoadFailedDiagnostic(message: string): CliDiagnostic {
  return {
    severity: 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_CHECK_PACK_LOAD_FAILED,
    category: 'runtime',
    message: `Plugin failed to load — ${message}`,
    impact: 'Checks from the failed plugin will not run.',
    provenance: { toolId: 'fitness' },
  };
}
