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

import { logger } from '../lib/logger.js';
import { currentScope } from '../lib/run-scope.js';

import { checkCapabilityContributionCompatibility } from './capability-compatibility.js';
import {
  discoverCapabilityContributions,
  type CapabilityPackageAdmission,
  type CapabilityContributionLoader,
  type CapabilityDiscoveryDiagnostic,
  type CapabilityDiscoveryPreferences,
  type RawCapabilityContribution,
  type SelectedCapabilityPackage,
} from './capability-discovery.js';
import { selectPackages } from './capability-package-selection.js';

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
  /** Optional pre-import package admission gate. Core stays policy-free. */
  readonly shouldLoadPackage?: (pkg: SelectedCapabilityPackage) => CapabilityPackageAdmission;
  /** Optional caller-owned contribution loader, used for isolated external packages. */
  readonly contributionLoader?: CapabilityContributionLoader;
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
  const {
    registry,
    domainId,
    projectDir,
    cliDir,
    preferences,
    shouldLoadPackage,
    contributionLoader,
    onDiagnostic,
  } = options;
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
  // Count the selected pack set without a diagnostic sink so the real discovery
  // pass (below) remains the single author of per-package errors.
  const selected = selectPackages({
    descriptor,
    projectDir: projectKey,
    ...(cliDir === undefined ? {} : { cliDir }),
    ...(preferences === undefined ? {} : { preferences }),
  });
  const contributions = await discoverCapabilityContributions({
    descriptor,
    projectDir: projectKey,
    ...(cliDir === undefined ? {} : { cliDir }),
    ...(preferences === undefined ? {} : { preferences }),
    ...(shouldLoadPackage === undefined ? {} : { shouldLoadPackage }),
    ...(contributionLoader === undefined ? {} : { contributionLoader }),
    onDiagnostic: (diagnostic) => {
      errors.push(formatDiscoveryError(domainId, diagnostic));
      onDiagnostic?.(diagnostic);
    },
  });

  let routed = 0;
  const sourcePackages = new Set<string>();
  for (const contribution of contributions) {
    if (routeLoadedContribution(registry, domainId, contribution, errors)) {
      routed++;
      sourcePackages.add(contribution.sourcePackage);
    }
  }

  registry.markDomainLoaded(domainId, projectKey, errors);
  emitLoadedEvent(domainId, routed, errors, {
    cliDir,
    packages: [...sourcePackages].sort(),
    selectedCount: selected.length,
    seededCount: preferences?.packages?.length,
  });
  return errors;
}

function routeLoadedContribution(
  registry: CapabilityRegistry,
  domainId: string,
  loaded: RawCapabilityContribution,
  errors: string[],
): boolean {
  const { sourcePackage, packageTargetDomain, packageTargetDomainApiVersion } = loaded;
  const target = loaded.targetDomainId ?? packageTargetDomain ?? domainId;
  const domainSpec = registry.getDomain(target);
  if (domainSpec === undefined) {
    errors.push(`${sourcePackage} → ${target}: unknown capability domain '${target}'`);
    return false;
  }
  const compatibility = checkCapabilityContributionCompatibility({
    targetDomainId: target,
    packageTargetDomain,
    packageTargetDomainApiVersion,
    domainSpec,
  });
  if (compatibility.kind === 'incompatible') {
    recordCompatibilityError(sourcePackage, target, compatibility, errors);
    return false;
  }
  try {
    registry.routeContribution(target, loaded.contribution, { sourcePackage });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({
      evt: 'capability.route.failed',
      module: 'core:plugins',
      sourcePackage,
      targetDomainId: target,
      error: msg,
    });
    errors.push(`${sourcePackage} → ${target}: ${msg}`);
    return false;
  }
}

function recordCompatibilityError(
  sourcePackage: string,
  target: string,
  compatibility: Extract<
    ReturnType<typeof checkCapabilityContributionCompatibility>,
    { readonly kind: 'incompatible' }
  >,
  errors: string[],
): void {
  const msg = compatibility.reason;
  errors.push(`${sourcePackage} → ${target}: ${msg}`);
  logger.warn({
    evt: 'capability.compatibility.rejected',
    module: 'core:plugins',
    sourcePackage,
    targetDomainId: target,
    declaredTargetDomain: compatibility.declaredTargetDomain,
    declaredApiVersion: compatibility.declaredApiVersion,
    minSupportedApiVersion: compatibility.minSupportedApiVersion,
    currentApiVersion: compatibility.currentApiVersion,
    message: msg,
  });
}

function formatDiscoveryError(domainId: string, diagnostic: CapabilityDiscoveryDiagnostic): string {
  const packageName = diagnostic.packageName?.trim();
  if (packageName === undefined || packageName.length === 0) return diagnostic.message;
  return `${packageName} → ${domainId}: ${diagnostic.message}`;
}

/**
 * Emit one unified `capability.<domainId>.loaded` lifecycle event on the
 * scope-owned diagnostics bus (the single vocabulary that replaces the three
 * per-domain event sets). No-op when there is no active scope (a programmatic
 * call outside `runWithScope`).
 *
 * The event carries the resolving `anchor` (cliDir) and the distinct
 * `packages` routed, so two loads of the SAME domain that resolve a different
 * pack set (the in-process host-seeded load vs a dispatched-worker load) are
 * directly comparable in `--json` diagnostics — the divergence names itself
 * instead of requiring a bisect.
 *
 * **Unexpected-zero contract (finishes ADR-0174):** when discovery selected
 * packs but routed 0 contributions, or routed fewer packs than an explicit
 * seed list, the level is `warn` (not silent info) and `data.gap` names the
 * shortfall. Legitimate no-ops stay quiet at this layer:
 * - domain with no `discovery` descriptor (caller returns before emit)
 * - no capability plane / tool declares no domains (never calls this loader)
 * A clean load (selected === routed, no errors) stays `info`.
 */
function emitLoadedEvent(
  domainId: string,
  routed: number,
  errors: readonly string[],
  resolution: {
    readonly cliDir?: string;
    readonly packages: readonly string[];
    readonly selectedCount: number;
    readonly seededCount?: number;
  },
): void {
  const gap = resolveLoadGap({
    routed,
    errorCount: errors.length,
    packageCount: resolution.packages.length,
    selectedCount: resolution.selectedCount,
    seededCount: resolution.seededCount,
  });
  const level = gap === undefined ? 'info' : 'warn';
  const base =
    `capability domain '${domainId}' loaded ${String(routed)} contribution(s) from ${String(resolution.packages.length)} pack(s)` +
    (errors.length > 0 ? `, ${String(errors.length)} error(s)` : '');
  const message = gap === undefined ? base : `${base} (${formatGap(gap, resolution)})`;

  currentScope()?.diagnostics.event('load', level, message, {
    domainId,
    routed,
    errors: errors.length,
    packageCount: resolution.packages.length,
    packages: resolution.packages,
    selectedCount: resolution.selectedCount,
    ...(resolution.seededCount === undefined ? {} : { seededCount: resolution.seededCount }),
    ...(gap === undefined ? {} : { gap }),
    ...(resolution.cliDir === undefined ? {} : { anchor: resolution.cliDir }),
  });
}

/** Gap kinds for the unexpected-zero / seed-shortfall contract. */
type CapabilityLoadGap = 'zero-routed' | 'seed-shortfall' | 'errors';

function resolveLoadGap(input: {
  readonly routed: number;
  readonly errorCount: number;
  readonly packageCount: number;
  readonly selectedCount: number;
  readonly seededCount?: number;
}): CapabilityLoadGap | undefined {
  if (input.errorCount > 0) return 'errors';
  // Selected packs but zero contributions routed — unexpected empty surface.
  if (input.selectedCount > 0 && input.routed === 0) return 'zero-routed';
  // Explicit config seeded more pack names than successfully contributed.
  if (
    input.seededCount !== undefined &&
    input.seededCount > 0 &&
    input.packageCount < input.seededCount
  ) {
    return 'seed-shortfall';
  }
  return undefined;
}

function formatGap(
  gap: CapabilityLoadGap,
  resolution: {
    readonly packages: readonly string[];
    readonly selectedCount: number;
    readonly seededCount?: number;
  },
): string {
  if (gap === 'zero-routed') {
    return `unexpected zero: selected ${String(resolution.selectedCount)} pack(s), routed 0`;
  }
  if (gap === 'seed-shortfall') {
    return `seed shortfall: ${String(resolution.packages.length)}/${String(resolution.seededCount ?? 0)} pack(s)`;
  }
  return 'with errors';
}
