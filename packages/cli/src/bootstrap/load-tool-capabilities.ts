/**
 * load-tool-capabilities — the composition-root seam that drives the generic
 * capability loader (§5.3, §4.5) for the invoked tool's declared domains.
 *
 * Replaces the host-coupled, eager `register-graph-adapters.ts` (which statically
 * imported graph's discover functions + stashed adapters in a module global).
 * Here the host stays tool-agnostic: for the tool that owns the running command,
 * it reads each declared capability domain's discovery descriptor off the
 * per-run capability registry, resolves that domain's preferences from the
 * project config through the keys the descriptor declares, and calls the generic
 * `loadCapabilityDomain` — which walks node_modules, imports each contributing
 * package, and routes every contribution through the owner's registrar. No tool
 * import; no module singleton; lazy per command (only the invoked tool's domains
 * load, so `graph` does not load fit-packs).
 *
 * This module is one of the few places the CLI imports `@opensip-cli/config`
 * (the preference resolver) — tools never do.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCapabilityPreferences, type CapabilityPreferences } from '@opensip-cli/config';
import {
  capabilityDiscoveryToCliDiagnostic,
  currentCapabilityRegistry,
  currentScope,
  loadCapabilityDomain,
  logger,
  type CapabilityDiscoveryDescriptor,
  type CapabilityPackageAdmission,
  type SelectedCapabilityPackage,
  type Tool,
} from '@opensip-cli/core';

import { BUNDLED_CAPABILITY_PACKS } from './bundled-manifest.js';
import { CAPABILITY_PACK_ALLOWLIST_ENV, isCapabilityPackTrusted } from './tool-trust.js';

/**
 * Resolve the directory the CLI was installed into. BUILT-IN capability packs
 * (the bundled `@opensip-cli/*` check packs + graph adapters, declared as CLI
 * dependencies) always resolve from here — a project never carries them, and a
 * globally-installed CLI runs ITS OWN bundled packs. This file lives at
 * `cli/dist/bootstrap/`, so the package root is three directories up.
 */
function cliInstallDir(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** Options for {@link loadOwningToolCapabilities}. */
export interface LoadOwningToolCapabilitiesOptions {
  /** The tool that owns the invoked command (from `resolveOwningTool`); `undefined` for CLI-only commands. */
  readonly owningTool: Tool | undefined;
  /** Discovery anchor for consumer-owned packages (the project root). */
  readonly projectDir: string;
  /** The host-validated `plugins:` block from `scope.configDocument`, or `{}` when absent. */
  readonly pluginsConfig?: unknown;
  /** Discovery anchor for built-in packs (those under a descriptor's `builtinScope`). */
  readonly cliDir?: string;
}

/**
 * Discover + route every contribution for each capability domain the invoked
 * tool declares, through the generic loader. Must run AFTER the scope is entered
 * (the registrars register into the scope's registries) and the per-run
 * capability registry is attached. A CLI-only command (no owning tool) loads
 * nothing.
 *
 * Returns the number of domains driven (0 when the tool declares none / is
 * CLI-only), for diagnostics.
 */
export async function loadOwningToolCapabilities(
  options: LoadOwningToolCapabilitiesOptions,
): Promise<number> {
  const { owningTool, projectDir, pluginsConfig = {} } = options;
  if (!owningTool) return 0;
  // Built-in packs (those under a descriptor's `builtinScope`, e.g. the bundled
  // @opensip-cli/graph-* adapters) resolve from the CLI's own install tree.
  const cliDir = options.cliDir ?? cliInstallDir();

  // The per-run capability registry is read off the current scope (the loader's
  // registrars register into this same scope's tool registries).
  const registry = currentCapabilityRegistry();

  const ownedDomains = registry
    .listDomains()
    .filter((d) => d.ownerToolId === owningTool.metadata.id);

  let driven = 0;
  for (const domain of ownedDomains) {
    const descriptor = domain.discovery;
    if (descriptor === undefined) continue;
    const preferences = augmentBundledCapabilityPreferences(
      descriptor,
      resolveCapabilityPreferences(descriptor, pluginsConfig),
    );
    await loadCapabilityDomain({
      registry,
      domainId: domain.id,
      projectDir,
      cliDir,
      preferences,
      shouldLoadPackage: (pkg) => admitCapabilityPackage(descriptor, pkg),
      onDiagnostic: (diagnostic) => {
        currentScope()?.bootstrapDiagnostics.record(
          capabilityDiscoveryToCliDiagnostic(diagnostic, domain.id, {
            toolId: owningTool.metadata.id,
            capabilityDomain: domain.id,
          }),
        );
      },
    });
    driven++;
  }
  return driven;
}

function admitCapabilityPackage(
  descriptor: CapabilityDiscoveryDescriptor,
  pkg: SelectedCapabilityPackage,
): CapabilityPackageAdmission {
  if (isBundledCapabilityPack(descriptor, pkg.name)) {
    return capabilityPackProvenancePassthrough(pkg, { admit: true });
  }
  if (isCapabilityPackTrusted(pkg.name)) {
    return capabilityPackProvenancePassthrough(pkg, { admit: true });
  }
  const reason = `set ${CAPABILITY_PACK_ALLOWLIST_ENV} to '${pkg.name}'`;
  logger.warn({
    evt: 'cli.capability.trust_denied',
    module: 'cli:capability',
    packageName: pkg.name,
    packageDir: pkg.packageDir,
    envVar: CAPABILITY_PACK_ALLOWLIST_ENV,
    message: `capability pack ${pkg.name} denied by trust policy`,
  });
  return capabilityPackProvenancePassthrough(pkg, { admit: false, reason });
}

function capabilityPackProvenancePassthrough(
  _pkg: SelectedCapabilityPackage,
  admission: CapabilityPackageAdmission,
): CapabilityPackageAdmission {
  // ADR-0081: `requires` is declaration-only until consumption-side provenance
  // and capability enforcement graduate from trust metadata to policy.
  return admission;
}

function isBundledCapabilityPack(
  descriptor: CapabilityDiscoveryDescriptor,
  packageName: string,
): boolean {
  if (descriptor.discovery.mode !== 'marker') return false;
  return BUNDLED_CAPABILITY_PACKS[descriptor.discovery.markerKind]?.includes(packageName) ?? false;
}

/**
 * Seed manifest-declared built-in packs when config did not supply an explicit
 * package list. Domains with `explicitListMode: 'augment'` still auto-discover
 * project-local packs on top of this list.
 */
function augmentBundledCapabilityPreferences(
  descriptor: CapabilityDiscoveryDescriptor,
  preferences: CapabilityPreferences,
): CapabilityPreferences {
  if (preferences.packages !== undefined) return preferences;
  if (descriptor.discovery.mode !== 'marker') return preferences;
  const bundled = BUNDLED_CAPABILITY_PACKS[descriptor.discovery.markerKind];
  if (bundled === undefined || bundled.length === 0) return preferences;
  return { ...preferences, packages: [...bundled] };
}
