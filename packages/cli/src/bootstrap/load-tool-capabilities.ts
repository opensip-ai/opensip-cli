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
  type CapabilityBridgeContribution,
  type CapabilityContributionLoader,
  type CapabilityDiscoveryDescriptor,
  type CapabilityPackageAdmission,
  type CapabilityResourceDecision,
  type RawCapabilityContribution,
  type SelectedCapabilityPackage,
  type Tool,
} from '@opensip-cli/core';

import { BUNDLED_CAPABILITY_PACKS } from './bundled-manifest.js';
import { runCapabilityWorkerSpec } from './capability-worker/supervisor.js';
import { policyCiEvidenceFromCurrentEnv } from './policy-evidence.js';
import {
  evaluatePolicyPep,
  policyAuditFromCurrentScope,
  policyFromCurrentScope,
} from './policy-pep.js';
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
  // @sequential-ok — bounded by a single tool's declared discovery domains;
  // each capability import registers into shared scope, so serial-by-design.
  for (const domain of ownedDomains) {
    const descriptor = domain.discovery;
    if (descriptor === undefined) continue;
    const configuredPreferences = resolveCapabilityPreferences(descriptor, pluginsConfig);
    const explicitlyConfiguredPackages = new Set(configuredPreferences.packages);
    const preferences = augmentBundledCapabilityPreferences(descriptor, configuredPreferences);
    await loadCapabilityDomain({
      registry,
      domainId: domain.id,
      projectDir,
      cliDir,
      preferences,
      shouldLoadPackage: (pkg) =>
        admitCapabilityPackage(descriptor, pkg, explicitlyConfiguredPackages),
      contributionLoader: createIsolatedContributionLoader({
        owningTool,
        domainId: domain.id,
        projectDir,
      }),
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

interface IsolatedContributionLoaderArgs {
  readonly owningTool: Tool;
  readonly domainId: string;
  readonly projectDir: string;
}

function createIsolatedContributionLoader(
  args: IsolatedContributionLoaderArgs,
): CapabilityContributionLoader {
  return (pkg, context) => loadIsolatedContribution(args, pkg, context);
}

/**
 * Use the owning tool's bridge to turn a worker-isolated package into host-side
 * proxy contributions.
 *
 * @throws {Error} when policy requires worker isolation but the tool exposes no
 * bridge for that domain.
 */
async function loadIsolatedContribution(
  args: IsolatedContributionLoaderArgs,
  pkg: SelectedCapabilityPackage,
  context: Parameters<CapabilityContributionLoader>[1],
): Promise<readonly RawCapabilityContribution[] | undefined> {
  const resourceDecision = context.admission.resourceDecision;
  if (resourceDecision?.isolation !== 'worker') return undefined;
  const bridge = args.owningTool.extensionPoints?.capabilityIsolationBridges?.[args.domainId];
  if (bridge === undefined) {
    throw new Error(
      `capability domain '${args.domainId}' does not support isolated external packages`,
    );
  }
  const contributions = await bridge.createHostContributions({
    domainId: args.domainId,
    descriptor: context.descriptor,
    pkg,
    resourceDecision,
    invoke: (request) =>
      runCapabilityWorkerSpec({
        cwd: args.projectDir,
        spec: {
          ownerToolId: args.owningTool.metadata.id,
          domainId: args.domainId,
          descriptor: context.descriptor,
          pkg,
          resourceDecision,
          request,
        },
      }),
  });
  return contributions.map((contribution) =>
    rawContributionFromBridge(pkg, resourceDecision, contribution),
  );
}

function rawContributionFromBridge(
  pkg: SelectedCapabilityPackage,
  resourceDecision: CapabilityResourceDecision,
  contribution: CapabilityBridgeContribution,
): RawCapabilityContribution {
  return {
    contribution: contribution.contribution,
    sourcePackage: pkg.name,
    ...(contribution.targetDomainId === undefined
      ? {}
      : { targetDomainId: contribution.targetDomainId }),
    ...(pkg.packageTargetDomain === undefined
      ? {}
      : { packageTargetDomain: pkg.packageTargetDomain }),
    ...(pkg.packageTargetDomainApiVersion === undefined
      ? {}
      : { packageTargetDomainApiVersion: pkg.packageTargetDomainApiVersion }),
    ...(pkg.packageRequires === undefined ? {} : { packageRequires: pkg.packageRequires }),
    ...(pkg.packageManifestHash === undefined
      ? {}
      : { packageManifestHash: pkg.packageManifestHash }),
    resourceDecision,
  };
}

function admitCapabilityPackage(
  descriptor: CapabilityDiscoveryDescriptor,
  pkg: SelectedCapabilityPackage,
  explicitlyConfiguredPackages: ReadonlySet<string>,
): CapabilityPackageAdmission {
  if (pkg.packageRequiresInvalid === true) {
    return {
      admit: false,
      reason: `package ${pkg.name} has an invalid opensipTools.requires declaration`,
    };
  }
  const bundled = isBundledCapabilityPack(descriptor, pkg.name);
  const explicitlyConfigured = explicitlyConfiguredPackages.has(pkg.name);
  const envTrusted = isCapabilityPackTrusted(pkg.name);
  const policyDecision = evaluatePolicyPep({
    policy: policyFromCurrentScope(),
    audit: policyAuditFromCurrentScope(),
    subject: {
      kind: 'capability-pack',
      id: pkg.name,
      packageName: pkg.name,
      source: 'capability-pack',
    },
    action: 'load',
    evidence: {
      legacyTrusted: bundled || explicitlyConfigured || envTrusted,
      bundled,
      explicitlyConfigured,
      envAllowed: envTrusted,
      capabilityExport: descriptor.exportName,
      declaredResources: pkg.packageRequires ?? [],
      targetDomain: pkg.packageTargetDomain,
      manifestHash: pkg.packageManifestHash,
      provenanceStatus: bundled ? 'verified' : 'unavailable',
      ci: policyCiEvidenceFromCurrentEnv(),
    },
  });
  const resourceDecision = policyResourceDecisionToCapability(policyDecision.decision);
  if (policyDecision.allowed && resourceDecision === undefined) {
    return {
      admit: false,
      reason: `policy allowed ${pkg.name} but did not return a capability resource decision`,
    };
  }
  if (bundled && policyDecision.allowed) {
    return capabilityPackProvenancePassthrough(pkg, { admit: true, resourceDecision });
  }
  if (explicitlyConfigured && policyDecision.allowed) {
    return capabilityPackProvenancePassthrough(pkg, { admit: true, resourceDecision });
  }
  if (envTrusted && policyDecision.allowed) {
    return capabilityPackProvenancePassthrough(pkg, { admit: true, resourceDecision });
  }
  const configuredPackageKey = descriptor.configKeys.packages;
  const configuredPackageHint =
    configuredPackageKey === undefined ? '' : ` or list it in plugins.${configuredPackageKey}`;
  const reason = policyDecision.allowed
    ? `set ${CAPABILITY_PACK_ALLOWLIST_ENV} to '${pkg.name}'${configuredPackageHint}`
    : policyDecision.decision.reasons.join('; ');
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
  // ADR-0128: resource decisions are produced by the policy plane and consumed by
  // the worker/proxy path. The loader only carries the decision through.
  return admission;
}

function policyResourceDecisionToCapability(decision: {
  readonly resourceDecision?: CapabilityResourceDecision;
}): CapabilityResourceDecision | undefined {
  return decision.resourceDecision;
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
