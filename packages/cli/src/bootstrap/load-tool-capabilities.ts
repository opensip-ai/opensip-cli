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

import { resolveCapabilityPreferences } from '@opensip-cli/config';
import { currentCapabilityRegistry, loadCapabilityDomain, type Tool } from '@opensip-cli/core';

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
    if (domain.discovery === undefined) continue;
    const preferences = resolveCapabilityPreferences(domain.discovery, pluginsConfig);
    await loadCapabilityDomain({ registry, domainId: domain.id, projectDir, cliDir, preferences });
    driven++;
  }
  return driven;
}
