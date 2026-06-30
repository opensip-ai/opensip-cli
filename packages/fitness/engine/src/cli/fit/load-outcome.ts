/**
 * Fitness load failure classification (ADR-0060, Phase 4).
 *
 * Distinguishes fail-closed command errors (empty registry, required plugin/check-pack
 * failures) from strict degraded runs (optional plugin failures while built-in checks
 * still loaded).
 */

import { EXIT_CODES, type ErrorResult } from '@opensip-cli/contracts';
import {
  CLI_DIAGNOSTIC_CODES,
  classifyModuleError,
  currentScope,
  discoverPlugins,
  readProjectPluginsList,
  withLogRef,
  type CliDiagnostic,
} from '@opensip-cli/core';

import { currentCheckRegistry, currentFitnessLoadState } from '../../framework/scope-registry.js';
import { FIT_PLUGIN_LAYOUT } from '../../plugins/loader.js';

/** Prefix before the colon in `loadAllPlugins` error strings (`source: message`). */
function pluginErrorSource(error: string): string {
  const idx = error.indexOf(':');
  return idx === -1 ? error.trim() : error.slice(0, idx).trim();
}

/** Package name mentioned in a fit-pack domain load error string. */
function checkPackErrorPackage(error: string): string | undefined {
  const trimmed = error.trim();
  const arrow = /^([^→]+)→/.exec(trimmed);
  if (arrow !== null) return arrow[1].trim();
  const configured = /^configured package "([^"]+)"/.exec(trimmed);
  if (configured !== null) return configured[1]?.trim();
  const packageWord = /^(?:failed to load )?package\s+((?:@[^/\s]+\/)?[^:\s]+)\b/.exec(trimmed);
  if (packageWord !== null) return packageWord[1]?.trim();
  const colon = /^([^:]+):/.exec(trimmed);
  return colon?.[1]?.trim();
}

function requiredCheckPackages(_projectDir: string): ReadonlySet<string> {
  const plugins = currentScope()?.configDocument?.plugins;
  if (plugins === null || plugins === undefined || typeof plugins !== 'object') {
    return new Set();
  }
  const checkPackages = (plugins as { checkPackages?: unknown }).checkPackages;
  return Array.isArray(checkPackages)
    ? new Set(checkPackages.filter((v): v is string => typeof v === 'string'))
    : new Set();
}

function isRequiredPluginSource(source: string, projectDir: string): boolean {
  const discovered = discoverPlugins(FIT_PLUGIN_LAYOUT, projectDir);
  const match = discovered.find((p) => p.source === source || p.namespace === source);
  if (match?.type === 'file') return true;
  const declared = readProjectPluginsList(projectDir, 'fit');
  if (declared?.includes(source) === true) return true;
  return false;
}

function emptyRegistryDiagnostic(): CliDiagnostic {
  return stampDiagnostic({
    severity: 'error',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY,
    category: 'integrity',
    message: 'No fitness checks were loaded for this project.',
    impact: 'The run cannot produce credible findings because the check registry is empty.',
    action:
      'Install at least one package declaring the fit-pack marker plus target-domain epoch, ' +
      'or declare plugins.checkPackages in opensip-cli.config.yml.',
    provenance: { toolId: 'fit', capabilityDomain: 'fit-pack' },
  });
}

function checkPackLoadDiagnostic(packageName: string, detail: string): CliDiagnostic {
  return checkPackDiagnostic(packageName, detail, 'required');
}

function checkPackDiagnostic(
  packageName: string,
  detail: string,
  mode: 'required' | 'optional',
): CliDiagnostic {
  const provenance = {
    toolId: 'fit',
    packageName,
    capabilityDomain: 'fit-pack',
  };
  const displayDetail = checkPackDisplayDetail(packageName, detail);
  const classified = classifiedLoaderDetail(displayDetail, provenance);
  const required = mode === 'required';
  const message = required
    ? `Required check pack "${packageName}" failed to load.`
    : `Optional check pack failed to load: ${displayDetail}`;
  return stampDiagnostic({
    severity: required ? 'error' : 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_CHECK_PACK_LOAD_FAILED,
    category: required ? 'runtime' : 'degraded',
    message,
    impact: required
      ? 'A required fit-pack could not be loaded, so the run cannot proceed.'
      : 'Some optional check packs were skipped; required checks still ran.',
    ...(required
      ? {
          action:
            'Verify the package is installed, built, and listed correctly in plugins.checkPackages.',
        }
      : {}),
    provenance,
    detail: classified.detail,
  });
}

function checkPackDisplayDetail(packageName: string, detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed.startsWith(packageName)) return trimmed;

  const afterPackage = trimmed.slice(packageName.length).trimStart();
  if (!afterPackage.startsWith('→')) return trimmed;

  const afterArrow = afterPackage.slice('→'.length).trimStart();
  const separator = afterArrow.indexOf(':');
  if (separator === -1) return trimmed;

  return afterArrow.slice(separator + 1).trim() || trimmed;
}

function stampDiagnostic(diagnostic: CliDiagnostic): CliDiagnostic {
  return withLogRef(diagnostic, currentScope()?.runId);
}

function classifiedLoaderDetail(
  detail: string,
  provenance: CliDiagnostic['provenance'],
): { readonly message: string; readonly detail?: string } {
  const classified = classifyModuleError(new Error(detail), provenance);
  return { message: classified.message, detail: classified.detail };
}

function requiredPluginDiagnostic(source: string, detail: string): CliDiagnostic {
  return pluginDiagnostic(source, detail, 'required');
}

function pluginDiagnostic(
  source: string,
  detail: string,
  mode: 'required' | 'optional',
): CliDiagnostic {
  const provenance = {
    toolId: 'fit',
    packageName: source,
    discoverySource: mode === 'required' ? 'required-plugin' : 'optional-plugin',
  };
  const classified = classifiedLoaderDetail(detail, provenance);
  const required = mode === 'required';
  return stampDiagnostic({
    severity: required ? 'error' : 'warning',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_PLUGIN_LOAD_FAILED,
    category: required ? 'runtime' : 'degraded',
    message: `${required ? 'Required' : 'Optional'} fitness plugin "${source}" failed to load.`,
    impact: required
      ? 'A required project-local or declared plugin failed, so the run cannot proceed.'
      : 'Some optional checks were skipped; built-in checks still ran.',
    ...(required
      ? {
          action:
            'Fix the plugin module or remove it from the project opensip-cli/fit tree / plugins.fit list.',
        }
      : {}),
    provenance,
    detail: classified.detail,
  });
}

function optionalPluginDiagnostic(source: string, detail: string): CliDiagnostic {
  return pluginDiagnostic(source, detail, 'optional');
}

function optionalCheckPackDiagnostic(packageName: string, detail: string): CliDiagnostic {
  return checkPackDiagnostic(packageName, detail, 'optional');
}

function partitionPluginFailures(
  errors: readonly string[],
  projectDir: string,
): { readonly required: CliDiagnostic[]; readonly optional: CliDiagnostic[] } {
  const required: CliDiagnostic[] = [];
  const optional: CliDiagnostic[] = [];
  for (const err of errors) {
    const source = pluginErrorSource(err);
    const detail = err.includes(':') ? err.slice(err.indexOf(':') + 1).trim() : err;
    if (isRequiredPluginSource(source, projectDir)) {
      required.push(requiredPluginDiagnostic(source, detail));
    } else {
      optional.push(optionalPluginDiagnostic(source, detail));
    }
  }
  return { required, optional };
}

function partitionCheckPackFailures(
  errors: readonly string[],
  requiredPackages: ReadonlySet<string>,
): { readonly required: CliDiagnostic[]; readonly optional: CliDiagnostic[] } {
  const required: CliDiagnostic[] = [];
  const optional: CliDiagnostic[] = [];
  for (const err of errors) {
    const pkg = checkPackErrorPackage(err);
    if (pkg !== undefined && requiredPackages.has(pkg)) {
      required.push(checkPackLoadDiagnostic(pkg, err));
    } else {
      optional.push(optionalCheckPackDiagnostic(pkg ?? 'unknown', err));
    }
  }
  return { required, optional };
}

/**
 * Classify load-time failures recorded on `scope.fitness.load` and stamp
 * `commandError` / `loadDegraded` / `degradedDiagnostics`. Idempotent per run.
 */
export function finalizeFitLoadOutcome(projectDir: string): void {
  const load = currentFitnessLoadState();
  if (load.outcomeFinalized === true) return;

  const enabledCount = currentCheckRegistry().listEnabled().length;
  const pluginFailures = partitionPluginFailures(load.pluginLoadErrors, projectDir);
  const packFailures = partitionCheckPackFailures(
    load.checkPackErrors,
    requiredCheckPackages(projectDir),
  );

  if (pluginFailures.required.length > 0) {
    load.commandError = pluginFailures.required[0];
  } else if (packFailures.required.length > 0) {
    load.commandError = packFailures.required[0];
  } else if (enabledCount === 0) {
    load.commandError = emptyRegistryDiagnostic();
  } else if (pluginFailures.optional.length > 0 || packFailures.optional.length > 0) {
    load.loadDegraded = true;
    load.degradedDiagnostics = [...pluginFailures.optional, ...packFailures.optional];
    for (const diag of load.degradedDiagnostics) {
      load.loadWarnings.push(diag.message);
    }
  }

  load.outcomeFinalized = true;
}

/** Primary command-error diagnostic after {@link finalizeFitLoadOutcome}, if any. */
export function fitLoadCommandError(): CliDiagnostic | undefined {
  return currentFitnessLoadState().commandError;
}

/** Whether the load finished with optional-only failures (strict degraded). */
export function fitLoadIsDegraded(): boolean {
  return currentFitnessLoadState().loadDegraded === true;
}

/** Build the public `ErrorResult` for a fail-closed load outcome. */
export function fitCommandErrorResult(diagnostic: CliDiagnostic): ErrorResult & {
  readonly code: string;
  readonly diagnostic: CliDiagnostic;
} {
  return {
    type: 'error',
    message: diagnostic.message,
    ...(diagnostic.action === undefined ? {} : { suggestion: diagnostic.action }),
    exitCode: EXIT_CODES.RUNTIME_ERROR,
    code: diagnostic.code,
    diagnostic,
  };
}
