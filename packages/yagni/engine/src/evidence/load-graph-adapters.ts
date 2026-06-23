/**
 * Lazy-load graph language adapters for YAGNI graph evidence.
 *
 * The CLI host only drives capability discovery for the *owning* tool's domains
 * (`loadOwningToolCapabilities`). A plain `opensip yagni` run therefore does not
 * register graph adapters even though `scope.graph` exists (graph's
 * `contributeScope` runs for every bundled tool). Before building or refreshing
 * graph evidence, YAGNI must drive the `graph-adapter` domain itself — the same
 * pattern simulation uses for `sim-pack` in `ensureScenariosLoaded`.
 */

import { dirname } from 'node:path';

import { resolveCapabilityPreferences } from '@opensip-cli/config';
import {
  currentScope,
  loadCapabilityDomain,
  type CapabilityDiscoveryDescriptor,
  type CapabilityDiscoveryPreferences,
} from '@opensip-cli/core';

/** Built-in graph adapters bundled with the CLI (mirrors bundled-tools.manifest.json). */
const BUNDLED_GRAPH_ADAPTERS = [
  '@opensip-cli/graph-typescript',
  '@opensip-cli/graph-python',
  '@opensip-cli/graph-rust',
  '@opensip-cli/graph-go',
  '@opensip-cli/graph-java',
] as const;

function graphAdapterCount(): number {
  const scope = currentScope() as { graph?: { adapters?: { size?: number } } } | undefined;
  return scope?.graph?.adapters?.size ?? 0;
}

/**
 * Resolve the CLI package install root from the process entry script
 * (`.../dist/index.js` → two levels up). Used so built-in `@opensip-cli/graph-*`
 * adapters resolve from the CLI's own dependency tree when the consumer project
 * does not carry them.
 */
function resolveCliInstallDir(): string | undefined {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return undefined;
  return dirname(dirname(entry));
}

function augmentBundledGraphAdapterPreferences(
  descriptor: CapabilityDiscoveryDescriptor | undefined,
  preferences: CapabilityDiscoveryPreferences,
): CapabilityDiscoveryPreferences {
  if (preferences.packages !== undefined) return preferences;
  if (descriptor?.discovery.mode !== 'marker') return preferences;
  return { ...preferences, packages: [...BUNDLED_GRAPH_ADAPTERS] };
}

/** Register graph language adapters when this yagni run needs graph evidence. */
export async function ensureGraphAdaptersLoaded(projectDir: string): Promise<void> {
  if (graphAdapterCount() > 0) return;

  const scope = currentScope();
  const registry = scope?.capabilities;
  if (!registry?.hasDomain('graph-adapter')) return;
  if (registry.isDomainLoaded('graph-adapter', projectDir)) return;

  const descriptor = registry.getDomain('graph-adapter')?.discovery;
  const preferences = augmentBundledGraphAdapterPreferences(
    descriptor,
    descriptor === undefined
      ? {}
      : resolveCapabilityPreferences(descriptor, scope?.configDocument?.plugins ?? {}),
  );

  await loadCapabilityDomain({
    registry,
    domainId: 'graph-adapter',
    projectDir,
    cliDir: resolveCliInstallDir(),
    preferences,
  });
}
