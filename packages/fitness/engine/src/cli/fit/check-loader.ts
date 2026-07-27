/**
 * Plugin/check discovery + registration for the `fit` command.
 *
 * Owns the fit-lifecycle state (`loadedFor`, `pluginLoadErrors`,
 * `loadWarnings`) — a single unit of state, written exactly once per RUN
 * by `ensureChecksLoaded()` and read by the phase helpers downstream
 * (`buildFitEnvelope`, `buildFitPresentation`) plus the public
 * `getPluginLoadErrors()` / `getDisplayName()` / `getIcon()` accessors
 * that `FitView` and `report-data.ts` consume.
 *
 * As of the scope-owned-registries refactor (2.10.0) this state lives on
 * the RunScope (`scope.fitness.load`), NOT module singletons — two
 * concurrent fit runs (different scopes) carry independent load state.
 * The accessors read the current scope's slot via
 * `currentFitnessLoadState()`.
 *
 * Invariant: each binding is set by `ensureChecksLoaded()` and read by
 * the phase helpers; `executeFit`'s phase ordering is sequenced so the
 * readers always run after the setter completes.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCapabilityPreferences } from '@opensip-cli/config';
import {
  createToolLogger,
  createToolError,
  classifyModuleError,
  capabilityDiscoveryToCliDiagnostic,
  currentScope,
  loadCapabilityDomain,
} from '@opensip-cli/core';

import { fitnessErrorCatalog } from '../../errors/fitness-error-catalog.js';
import { currentCheckRegistry, currentFitnessLoadState } from '../../framework/scope-registry.js';
import { loadAllPlugins } from '../../plugins/loader.js';

import type { FitnessLoadFailure } from '../../scope-augmentation.js';
import type { CapabilityPackageAdmission, SelectedCapabilityPackage } from '@opensip-cli/core';

const log = createToolLogger('fitness:cli');

// ---------------------------------------------------------------------------
// Public accessors — all read the current RunScope's fitness load state
// (`scope.fitness.load`), set once per run by `ensureChecksLoaded()`.
// ---------------------------------------------------------------------------

/** Warnings collected during the most recent ensureChecksLoaded() call.
 * Returned alongside plugin errors and run-time validation warnings via
 * executeFit's result so the live renderer and JSON output both see them. */
export function getLoadWarnings(): readonly string[] {
  return currentFitnessLoadState().loadWarnings;
}

/**
 * Plugin load errors recorded during the most recent ensureChecksLoaded() call.
 * Read by runFit to fail the run if any plugin failed to import — otherwise a
 * malicious or broken plugin could silently suppress its own checks while the
 * CLI exits 0, masking a compliance failure or a supply-chain compromise.
 */
// @fitness-ignore-next-line duplicate-utility-functions -- intentionally parallel per-tool scope accessor: fit reads scope.fitness.load, sim reads scope.simulation.load; they cannot consolidate (different registries) and mirror getLoadWarnings.
export function getPluginLoadErrors(): readonly FitnessLoadFailure[] {
  return currentFitnessLoadState().pluginLoadErrors;
}

const LOAD_COMPONENT_FAILED = fitnessErrorCatalog.require('FIT.LOAD.COMPONENT_FAILED');

export function normalizePluginLoadFailure(message: string): FitnessLoadFailure {
  const separator = message.indexOf(':');
  const source = (separator === -1 ? message : message.slice(0, separator)).trim() || 'unknown';
  const detail = separator === -1 ? message.trim() : message.slice(separator + 1).trim();
  return normalizedLoadFailure('plugin', source, detail);
}

function checkPackSource(message: string): string {
  const trimmed = message.trim();
  const arrow = /^([^→]+)→/.exec(trimmed);
  if (arrow !== null) return arrow[1]?.trim() || 'unknown';
  const configured = /^configured package "([^"]+)"/.exec(trimmed);
  if (configured !== null) return configured[1]?.trim() || 'unknown';
  const packageWord = /^(?:failed to load )?package\s+((?:@[^/\s]+\/)?[^:\s]+)\b/.exec(trimmed);
  if (packageWord !== null) return packageWord[1]?.trim() || 'unknown';
  const colon = /^([^:]+):/.exec(trimmed);
  const source = colon?.[1]?.trim();
  return source === undefined || source === '' ? 'unknown' : source;
}

export function normalizeCheckPackLoadFailure(message: string): FitnessLoadFailure {
  return normalizedLoadFailure('check-pack', checkPackSource(message), message.trim());
}

function normalizedLoadFailure(
  component: FitnessLoadFailure['component'],
  source: string,
  detail: string,
): FitnessLoadFailure {
  const failure = createToolError(
    LOAD_COMPONENT_FAILED,
    `Fitness ${component} "${source}" failed to load.`,
    {
      cause: new Error(detail),
      metadata: { condition: component, component: source },
    },
  );
  const provenance = {
    toolId: 'fit',
    packageName: source,
    ...(component === 'check-pack'
      ? { capabilityDomain: 'fit-pack' }
      : { discoverySource: 'fitness-plugin' }),
  };
  const classified = classifyModuleError(new Error(detail), provenance);
  return {
    component,
    source,
    detail,
    failure,
    safeDetail: classified.detail ?? classified.message,
  };
}

/** Get the number of enabled checks (available after ensureChecksLoaded). */
export function getEnabledCheckCount(): number {
  return currentCheckRegistry().listEnabled().length;
}

// ---------------------------------------------------------------------------
// Lazy-load fitness checks
// ---------------------------------------------------------------------------

/** Lazily discovers and registers all check packs for the given project
 * (idempotent per project, scoped to the current RunScope). */
export async function ensureChecksLoaded(projectDir?: string): Promise<void> {
  const key = projectDir ?? '';
  // Per-run lifecycle state lives on the scope (`scope.fitness.load`), so
  // two concurrent fit runs (different scopes) load independently.
  const load = currentFitnessLoadState();
  if (load.loadedFor === key) return;

  // Reset per-run warning buffer. Its lifetime mirrors loadedFor —
  // a fresh load (new projectDir or first call) starts with no warnings.
  load.loadWarnings = [];
  load.checkPackErrors = [];
  load.degradedDiagnostics = [];
  load.commandError = undefined;
  load.loadDegraded = undefined;
  load.outcomeFinalized = undefined;

  // 1. Load fit plugins — discovers .mjs files in
  //    <projectDir>/opensip-cli/fit/{checks,recipes}/ and any
  //    npm packages declared in plugins.fit in the project config.
  //
  //    Bundled language adapters (TypeScript, Rust, Python, etc.)
  //    are registered separately by the CLI bootstrap; fitness
  //    doesn't take direct deps on @opensip-cli/lang-* packages,
  //    and there's no project-local 'lang' plugin discovery path
  //    (the lang adapter set is fixed and shipped with the CLI).
  const pluginResult = await loadAllPlugins('fit', projectDir);
  load.pluginLoadErrors = pluginResult.errors.map(normalizePluginLoadFailure);
  if (pluginResult.errors.length > 0) {
    // Structured classification happens in finalizeFitLoadOutcome; log only here.
    for (const failure of load.pluginLoadErrors) {
      log.warn({
        evt: 'cli.plugin.warning',
        module: 'cli:fit',
        err: failure.failure,
      });
    }
  }

  // 2. Discover + load fit-pack check packages through the GENERIC capability
  //    substrate (§5.3): marker discovery, the `@opensip-cli` built-in split,
  //    explicit `plugins.checkPackages` (augmented onto markers), and the
  //    single-core guard all live in core now — fitness no longer carries a
  //    bespoke loader. The fit-pack registrar registers each check; co-located
  //    `recipes` route to the fit-recipe domain. Memoized per (domain, project)
  //    on the scope capability registry, so the CLI pre-action hook and this
  //    call don't double-load. Discovery errors (incl. the single-core guard's
  //    foreign-core skips) surface as load warnings.
  const checkPackErrors = await loadFitCheckPackages(projectDir ?? cliInstallDir());
  load.checkPackErrors = checkPackErrors.map(normalizeCheckPackLoadFailure);

  load.loadedFor = key;

  // Classify required vs optional failures and stamp command-error / degraded state.
  const { finalizeFitLoadOutcome } = await import('./load-outcome.js');
  finalizeFitLoadOutcome(projectDir ?? '');
}

/**
 * Drive the generic capability loader for the `fit-pack` domain. Returns any
 * discovery/routing errors (foreign-core skips, load failures) as warning
 * strings. A no-op when the run carries no capability registry (a programmatic
 * fitness use that never wired the host capability plane) or the fit-pack domain
 * is unregistered. Preferences come from the host-validated `plugins:` block
 * on `scope.configDocument`, using the domain's manifest-declared config keys.
 */
async function loadFitCheckPackages(projectDir: string): Promise<readonly string[]> {
  const scope = currentScope();
  const registry = scope?.capabilities;
  if (!registry?.hasDomain('fit-pack')) return [];
  // The fit-pack capability load is memoized on ONE canonical key: the scope's
  // resolved project root. The host bootstrap driver (loadOwningToolCapabilities)
  // loads under that same key in its pre-action phase, so this engine-side call
  // observes the host's load and no-ops instead of re-loading under a divergent
  // anchor (`opts.cwd`, e.g. `.`) — the two-path / two-key split that made the
  // in-process and dispatched (external) fit surfaces diverge. Falls back to the
  // passed dir only for programmatic use with no host-built scope.
  const canonicalKey = scope?.projectContext?.projectRoot ?? projectDir;
  const descriptor = registry.getDomain('fit-pack')?.discovery;
  const preferences =
    descriptor === undefined
      ? {}
      : resolveCapabilityPreferences(descriptor, scope?.configDocument?.plugins ?? {});
  // Route package admission through the host trust gate published on the scope, so
  // this engine-triggered load applies the SAME policy as the CLI bootstrap: a
  // non-bundled builtin `@opensip-cli/*` pack (the private dogfood pack) that a
  // project did not opt into via `plugins.checkPackages` is DENIED, not admitted by
  // the permissive builtin default. Undefined outside a host scope (programmatic
  // use) → the core discovery default applies (unchanged). The explicit-package set
  // mirrors the host's pre-augment `explicitlyConfigured` (checkPackages only).
  const admit = scope?.capabilityAdmission;
  const explicitPackages = new Set(
    'packages' in preferences && Array.isArray(preferences.packages) ? preferences.packages : [],
  );
  const shouldLoadPackage =
    descriptor !== undefined && admit !== undefined
      ? (pkg: SelectedCapabilityPackage): CapabilityPackageAdmission =>
          admit(descriptor, pkg, explicitPackages)
      : undefined;
  const errors = registry.isDomainLoaded('fit-pack', canonicalKey)
    ? registry.domainLoadErrors('fit-pack')
    : await loadCapabilityDomain({
        registry,
        domainId: 'fit-pack',
        projectDir: canonicalKey,
        cliDir: cliInstallDir(),
        preferences,
        ...(shouldLoadPackage === undefined ? {} : { shouldLoadPackage }),
        onDiagnostic: (diagnostic) => {
          currentScope()?.bootstrapDiagnostics.record(
            capabilityDiscoveryToCliDiagnostic(diagnostic, 'fit-pack', {
              toolId: 'fitness',
              capabilityDomain: 'fit-pack',
            }),
          );
        },
      });
  for (const message of errors) {
    currentScope()?.bootstrapDiagnostics.record(
      capabilityDiscoveryToCliDiagnostic(
        { evt: 'capability.fit-pack.load_error', message },
        'fit-pack',
        { toolId: 'fitness', capabilityDomain: 'fit-pack' },
      ),
    );
  }
  return errors;
}

/**
 * Resolve the directory the CLI was installed into. Built-in check packs
 * (the @opensip-cli/* fit-packs declared as deps in cli/package.json) always
 * resolve from here, so a globally-installed CLI runs ITS OWN bundled checks at
 * its own version — a project pinning an older @opensip-cli/checks-* cannot
 * shadow them. Also the discovery fallback when no projectDir is supplied.
 * Walks up from this module's URL to the opensip-cli package root so
 * node_modules lookup sees the CLI's own dependency tree.
 */
function cliInstallDir(): string {
  // import.meta.url points at this file inside the CLI's dist/. The CLI
  // package root is two levels up from dist/commands/. Resolve via the
  // Node URL → path bridge to keep this OS-agnostic.
  const thisFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(thisFile)));
}
