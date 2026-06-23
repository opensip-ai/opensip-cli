
/**
 * register-tools — populate the kernel ToolRegistry with bundled, installed,
 * and authored tools (ADR-0027 / ADR-0041).
 *
 * Merged registration cluster: manifest constants, bundled admission,
 * installed/authored admission, and discovery walkers. Command mounting lives
 * in register-tools-mount.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  logger,
  PluginIncompatibleError,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { admitToolPackage, type AdmissionReport } from './admit-tool-package.js';
import { BUNDLED_TOOL_PACKAGES } from './bundled-manifest.js';
import { BOOTSTRAP_MODULE } from './constants.js';

export {
  BUNDLED_CAPABILITY_PACKS,
  BUNDLED_TOOL_PACKAGES,
  EXPECTED_SCAFFOLDING_TOOL_IDS,
} from './bundled-manifest.js';

/** Used to resolve the bundled engine package dirs from the CLI's own module graph. */
const requireFromHere = createRequire(import.meta.url);

/**
 * Resolve a bundled tool's PACKAGE DIR — the directory whose `package.json`
 * carries the `opensipTools` manifest.
 *
 * The `./package.json` subpath is not declared in each engine's `exports`,
 * so `require.resolve('<pkg>/package.json')` throws. Instead we resolve the
 * package's MAIN entry (a bare-name resolve, always permitted by `exports`)
 * and walk up to the nearest ancestor directory that has a `package.json`
 * whose `name` matches `packageName`. That ancestor IS the tool's own
 * package dir under both the source layout and pnpm's workspace-injected
 * `node_modules` layout (verified against fitness/simulation/graph here).
 *
 * @returns the resolved package directory, or `undefined` when the package
 *   cannot be resolved (should never happen for a bundled direct dep).
 */
export function resolveBundledPackageDir(packageName: string): string | undefined {
  let resolvedEntry: string;
  try {
    resolvedEntry = requireFromHere.resolve(packageName);
  } catch (error) {
    // A bundled direct dep failing to resolve is a packaging fault — log it
    // so the subsequent fail-closed throw is diagnosable, then signal the
    // unresolved state to the caller (which raises PluginIncompatibleError).
    logger.debug({
      evt: 'cli.tool.bundled_unresolved',
      module: BOOTSTRAP_MODULE,
      packageName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  let dir = dirname(resolvedEntry);
  for (let i = 0; i < 50; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const json = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: unknown;
        };
        if (json.name === packageName) return dir;
      } catch {
        // @swallow-ok unreadable package.json on the walk-up — keep climbing.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve a bundled tool package's on-disk directory, requiring success.
 *
 * @throws {PluginIncompatibleError} when the package directory cannot be
 *   resolved on disk (its manifest is unreadable).
 */
export function resolveRequiredBundledPackageDir(packageName: string): string {
  const dir = resolveBundledPackageDir(packageName);
  if (dir !== undefined) return dir;
  throw new PluginIncompatibleError(
    `bundled tool '${packageName}' could not be resolved on disk; its manifest is unreadable`,
    { diagnostic: 'package directory not resolvable' },
  );
}

// The runtime-load primitive (`importToolRuntime` + `ToolRuntimeLoad`) and the
// full admission SEQUENCE (`admitToolPackage`) live in `admit-tool-package.ts`
// (ADR-0041: one validator, four consumers). This file keeps the per-source
// POLICY: bundled fails closed below; the installed/authored legs skip with
// diagnostics.

/**
 * Register the bundled first-party tools into the supplied registry, each one
 * flowing through the SAME admit → dynamic-import → register path the external
 * path uses (launch cutover — replaces the static-import + gate path).
 *
 * Per package name: `resolveBundledPackageDir` → `loadToolManifest('bundled')`
 * → `admitTool({ source: 'bundled', explicitlyRequested: true })` →
 * `importToolRuntime` (dynamic import + shape validation) → drift guard →
 * `registry.register`. A bundled tool ships with the CLI, so it is always
 * explicitly present: a missing/incompatible manifest or a runtime that fails
 * to load is FAIL-CLOSED (never a silent skip). The recorded `ToolProvenance`
 * (source `'bundled'`, trusted-by-shipping) and manifest are pushed onto the
 * optional collectors so the composition root can surface provenance
 * (`plugin list`) and seed the per-run capability registry (§5.3).
 *
 * @param registry The per-invocation tool registry to populate.
 * @param provenance Optional sink for the admitted tools' provenance records.
 * @param manifests Optional sink for the admitted tools' manifests (§5.3).
 * @param packages The bundled package names to load (defaults to
 *   {@link BUNDLED_TOOL_PACKAGES}; injectable so the fail-closed paths are
 *   testable with fixture packages).
 * @throws {PluginIncompatibleError} when a bundled tool cannot be resolved,
 *   has no conformant manifest, is out of range, or its runtime fails to load
 *   — mapped to `EXIT_CODES.PLUGIN_INCOMPATIBLE` (exit 5) by the CLI boundary.
 */
export async function registerFirstPartyTools(
  registry: ToolRegistry,
  provenance: ToolProvenance[] = [],
  manifests: ToolPluginManifest[] = [],
  packages: readonly string[] = BUNDLED_TOOL_PACKAGES,
): Promise<void> {
  for (const packageName of packages) {
    const dir = resolveRequiredBundledPackageDir(packageName);

    // The shared admission SEQUENCE (ADR-0041). The bundled POLICY below maps
    // each failed section to the exact fail-closed error this path always
    // threw — a bundled tool ships with the CLI, so every failure is a
    // packaging fault, never a silent skip.
    const report = await admitToolPackage({
      dir,
      source: 'bundled',
      packageName,
      // A bundled tool ships with the CLI; it is always explicitly present,
      // so an incompatible manifest fails the run rather than skipping.
      explicitlyRequested: true,
    });

    if (!report.ok) {
      throwBundledAdmissionFailure(packageName, report);
    }
    /* v8 ignore next 3 -- throwBundledAdmissionFailure never returns on a failed report; this guard narrows types */
    if (
      report.tool === undefined ||
      report.provenance === undefined ||
      report.manifest === undefined
    ) {
      throw new PluginIncompatibleError(
        `bundled tool '${packageName}' produced an incomplete admission report`,
        { diagnostic: 'incomplete admission report' },
      );
    }

    registry.register(report.tool);
    provenance.push(report.provenance);
    // Record the manifest so the pre-action-hook can register this tool's
    // declared capability domains into the per-run capability registry
    // (launch, §5.3).
    manifests.push(report.manifest);
  }
}

/**
 * The bundled FAIL-CLOSED policy: convert a failed {@link AdmissionReport}
 * into the same `PluginIncompatibleError` (message + diagnostic) the inline
 * pipeline threw before the ADR-0041 factoring. Never returns.
 *
 * @throws {PluginIncompatibleError} always (or rethrows the original
 *   coherence error from `assertManifestMatchesTool`, preserving its type).
 */
function throwBundledAdmissionFailure(packageName: string, report: AdmissionReport): never {
  const failed = report.sections.find((s) => !s.ok);
  const failedSection = failed?.section;

  if (failedSection === 'manifest') {
    throw new PluginIncompatibleError(
      `bundled tool '${packageName}' has no conformant package.json#opensipTools manifest`,
      { diagnostic: 'manifest missing or malformed' },
    );
  }
  const id = report.manifest?.id ?? packageName;
  if (failedSection === 'compatibility') {
    if (report.compatibilityDecision === 'fail-closed') {
      throw new PluginIncompatibleError(
        `bundled tool '${id}' is incompatible: ${failed?.diagnostic ?? 'compatibility gate rejected it'}`,
        { diagnostic: failed?.diagnostic },
      );
    }
    if (report.compatibilityDecision === 'skip') {
      // Should not happen for an in-range bundled tool, but never silently
      // drop a bundled tool — surface it loudly.
      throw new PluginIncompatibleError(
        `bundled tool '${id}' was skipped by the compatibility gate: ${failed?.diagnostic ?? 'unknown reason'}`,
        { diagnostic: failed?.diagnostic },
      );
    }
    throw new PluginIncompatibleError(
      `bundled tool '${id}' reached an unknown admission decision`,
      { diagnostic: 'unknown admission decision' },
    );
  }
  if (failedSection === 'runtime-load' || failedSection === 'tool-shape') {
    const reason = report.runtimeLoadReason ?? 'import-failed';
    const detailSuffix = report.runtimeLoadDetail ? `: ${report.runtimeLoadDetail}` : '';
    throw new PluginIncompatibleError(
      `bundled tool '${id}' failed to load via the plugin path (${reason}${detailSuffix})`,
      { diagnostic: `bundled tool runtime load failed: ${reason}` },
    );
  }
  if (failedSection === 'manifest-runtime-coherence' && report.coherenceError instanceof Error) {
    // Preserve the original drift-guard error type + message untouched.
    // (assertManifestMatchesTool always throws Error subclasses; the
    // instanceof narrowing satisfies only-throw-error without a cast.)
    throw report.coherenceError;
  }
  /* v8 ignore next 4 -- defensive: a failed report always carries a failed section */
  throw new PluginIncompatibleError(
    `bundled tool '${packageName}' failed admission for an unknown reason`,
    { diagnostic: 'unknown admission failure' },
  );
}

export {
  admitProjectLocalTool,
  admitUserGlobalTool,
  discoverAndRegisterAuthoredTools,
  type AuthoredAdmission,
} from './register-authored-tools.js';
export {
  buildToolDiscoverySources,
  discoverAndRegisterToolPackages,
  emitInstalledLoadFailure,
  type DiscoveryOptions,
} from './register-tools-discovery.js';

export { mountAllToolCommands, mountOneTool } from './register-tools-mount.js';
