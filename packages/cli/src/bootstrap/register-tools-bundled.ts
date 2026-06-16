import {
  PluginIncompatibleError,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { admitToolPackage, type AdmissionReport } from './admit-tool-package.js';
import {
  BUNDLED_TOOL_PACKAGES,
  resolveRequiredBundledPackageDir,
} from './register-tools-shared.js';

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
      // @fitness-ignore-next-line detached-promises -- synchronous never-returning thrower; the heuristic mistakes the bare call for an unawaited promise
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
