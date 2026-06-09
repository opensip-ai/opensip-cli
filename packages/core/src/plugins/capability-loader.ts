/**
 * @fileoverview The scope-owned capability loader (§5.3, Phase 2) — the live
 * conduit that wakes `routeContribution`.
 *
 * `wireCapabilityRegistry` registers each manifest-declared domain and swaps in
 * the owner's real registrar, but never FEEDS the registry. This loader closes
 * the loop: for one domain it drives the generic discovery substrate
 * ({@link discoverCapabilityContributions}) and routes every contribution through
 * `registry.routeContribution(domainId, contribution)` → the owner's registrar →
 * the per-`RunScope` registry. That is the same end state the three bespoke
 * loaders reach (checks/scenarios/adapters), now through the one seam.
 *
 * Memoized per `(domainId, projectKey)` on the per-scope registry's load-state
 * (see {@link CapabilityRegistry}), NOT on a module-level marker — so a second
 * scope for the same project re-loads into its own fresh registry. This is the
 * structural fix for the audit's F1.
 *
 * Pure of config: preferences are RESOLVED BY THE CALLER (Phase 3) and passed in,
 * so this stays in `core` with no edge to the config/cli layer.
 */

import { currentScope } from '../lib/run-scope.js';

import {
  discoverCapabilityContributions,
  type CapabilityDiscoveryDiagnostic,
  type CapabilityDiscoveryPreferences,
} from './capability-discovery.js';

import type { CapabilityRegistry } from './capability-registry.js';

/** Options for {@link loadCapabilityDomain}. */
export interface LoadCapabilityDomainOptions {
  /** The per-scope registry that declares the domain + routes contributions. */
  readonly registry: CapabilityRegistry;
  /** The domain to discovery-load (must already be registered in `registry`). */
  readonly domainId: string;
  /** Discovery anchor for consumer-owned packages (the project root); `''` when none. */
  readonly projectDir?: string;
  /** Discovery anchor for built-ins (those under the descriptor's `builtinScope`). */
  readonly cliDir?: string;
  /** Resolved discovery preferences for this domain (Phase 3 resolves these from config). */
  readonly preferences?: CapabilityDiscoveryPreferences;
  /** Optional sink for the substrate's per-package discovery diagnostics. */
  readonly onDiagnostic?: (diagnostic: CapabilityDiscoveryDiagnostic) => void;
}

/**
 * Discovery-load one capability domain through the live `routeContribution` path,
 * memoized per `(domainId, projectKey)` on the scope-owned registry. Returns the
 * routing errors recorded for the domain (empty when all contributions routed
 * cleanly). Idempotent: a second call for the same domain + project is a no-op
 * that returns the prior errors.
 *
 * A domain with no `discovery` descriptor auto-discovers nothing — it is marked
 * loaded immediately with no contributions (its registrar is fed some other way,
 * e.g. an explicit in-process registration).
 */
export async function loadCapabilityDomain(
  options: LoadCapabilityDomainOptions,
): Promise<readonly string[]> {
  const { registry, domainId, projectDir, cliDir, preferences, onDiagnostic } = options;
  const projectKey = projectDir ?? '';

  if (registry.isDomainLoaded(domainId, projectKey)) {
    return registry.domainLoadErrors(domainId);
  }

  const descriptor = registry.getDomain(domainId)?.discovery;
  if (descriptor === undefined) {
    // No auto-discovery for this domain — mark loaded so we don't re-check.
    registry.markDomainLoaded(domainId, projectKey, []);
    return [];
  }

  const errors: string[] = [];
  const contributions = await discoverCapabilityContributions({
    descriptor,
    projectDir: projectKey,
    ...(cliDir === undefined ? {} : { cliDir }),
    ...(preferences === undefined ? {} : { preferences }),
    onDiagnostic: (diagnostic) => {
      errors.push(diagnostic.message);
      onDiagnostic?.(diagnostic);
    },
  });

  let routed = 0;
  for (const { contribution, sourcePackage } of contributions) {
    try {
      registry.routeContribution(domainId, contribution);
      routed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${sourcePackage}: ${msg}`);
    }
  }

  registry.markDomainLoaded(domainId, projectKey, errors);
  emitLoadedEvent(domainId, routed, errors);
  return errors;
}

/**
 * Emit one unified `capability.<domainId>.loaded` lifecycle event on the
 * scope-owned diagnostics bus (the single vocabulary that replaces the three
 * per-domain event sets). No-op when there is no active scope (a programmatic
 * call outside `runWithScope`).
 */
function emitLoadedEvent(domainId: string, routed: number, errors: readonly string[]): void {
  currentScope()?.diagnostics.event(
    'load',
    errors.length > 0 ? 'warn' : 'info',
    `capability domain '${domainId}' loaded ${String(routed)} contribution(s)` +
      (errors.length > 0 ? `, ${String(errors.length)} error(s)` : ''),
    { domainId, routed, errors: errors.length },
  );
}
