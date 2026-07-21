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
  currentScope,
  loadCapabilityDomain,
  logger,
  resolvePackageDir,
  type CapabilityBridgeContribution,
  type CapabilityContributionLoader,
  type CapabilityDiscoveryDescriptor,
  type CapabilityPackageAdmission,
  type CapabilityResourceDecision,
  type RawCapabilityContribution,
  type SelectedCapabilityPackage,
  type Tool,
  type ToolProvenance,
} from '@opensip-cli/core';

import { BUNDLED_CAPABILITY_PACKS } from './bundled-manifest.js';
import { runCapabilityWorkerSpec } from './capability-worker/supervisor.js';
import { policyCiEvidenceFromCurrentEnv } from './policy-evidence.js';
import {
  evaluatePolicyPep,
  policyAuditFromCurrentScope,
  policyFromCurrentScope,
} from './policy-pep.js';
import { shouldRunHookInHost } from './tool-provenance.js';

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
  /**
   * Per-run tool provenance. An EXTERNAL owning tool's capability domains are
   * loaded worker-side under dispatch (ADR-0054 M4-F), exactly as its
   * `initialize` hook is — its registrars do not exist in this process, so
   * loading here discovers every contribution and then fails to route all of
   * them. Omitted (or empty) keeps the bundled/in-host behaviour.
   */
  readonly provenance?: readonly ToolProvenance[];
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
  const { owningTool, projectDir, pluginsConfig = {}, provenance = [] } = options;
  if (!owningTool) return 0;
  // M4-F parity with `maybeInitializeOwningTool`: an external owning tool's
  // capability domains load worker-side. Driving them here routes 0 of N
  // contributions (the registrars are worker-local) and records N errors that
  // never reach stderr — a silent, wasted load.
  if (!shouldRunHookInHost(owningTool, provenance)) return 0;
  // Built-in packs (those under a descriptor's `builtinScope`, e.g. the bundled
  // @opensip-cli/graph-* adapters) resolve from the CLI's own install tree.
  const cliDir = options.cliDir ?? cliInstallDir();

  // The per-run capability registry is read SOFTLY off the current scope (the
  // loader's registrars register into this same scope's tool registries). A run
  // without a capability plane — a programmatic embed, or a dispatch worker
  // running a tool that declares no capability domains (an external scanner) —
  // is a clean no-op, never a throw: this driver is called from the worker path
  // (ADR-0174) where not every dispatched tool has a wired capability registry.
  const registry = currentScope()?.capabilities;
  if (registry === undefined) return 0;

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
    const preferences = augmentBundledCapabilityPreferences(
      descriptor,
      configuredPreferences,
      cliDir,
    );
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

/**
 * The host trust-policy capability-pack admission — the ENFORCED security
 * boundary for external capability packs (plan 09 Phase 3; capability-trust
 * ADR). Exported so it can be published on `RunScope.capabilityAdmission`
 * (build-per-run-scope): an engine that triggers its own capability load (the
 * fitness check-loader) then admits packs through THIS gate — identical to the
 * bootstrap path.
 *
 * Trust direction: a `plugins.<domain>` entry in the ANALYZED REPO's own
 * config is discovery/selection input, never operator trust — a tool whose
 * job is analyzing code it does not trust must not let that code nominate
 * executable packs. Operator trust is exactly one surface: the user-level
 * global-config trust list (`policy.trustedCapabilityPacks`), each grant an
 * exact id bound to the provenance (manifest hash) verified at grant time —
 * a trusted NAME alone would be shadowable through the repo's `node_modules`.
 */
export function admitCapabilityPackage(
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
  const grant = policyFromCurrentScope().capabilityGrants.find((entry) => entry.id === pkg.name);
  const grantMatches = grant !== undefined && grant.manifestHash === pkg.packageManifestHash;
  const operatorTrusted = bundled || grantMatches;
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
      legacyTrusted: operatorTrusted,
      bundled,
      // Informational only — analyzed-repo config selects packs, it does not
      // trust them (the audit record keeps the distinction visible).
      explicitlyConfigured,
      operatorGranted: grantMatches,
      capabilityExport: descriptor.exportName,
      declaredResources: pkg.packageRequires ?? [],
      targetDomain: pkg.packageTargetDomain,
      manifestHash: pkg.packageManifestHash,
      provenanceStatus: operatorTrusted ? 'verified' : 'unavailable',
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
  if (operatorTrusted && policyDecision.allowed) {
    return capabilityPackProvenancePassthrough(pkg, {
      admit: true,
      resourceDecision,
      // Bundled packs are host components: their load failure must fail the
      // run loudly, never silently shrink the check surface.
      ...(bundled ? { required: true } : {}),
    });
  }
  const reason = admissionDenialReason(pkg, grant !== undefined, policyDecision);
  logger.warn({
    evt: 'cli.capability.trust_denied',
    module: 'cli:capability',
    packageName: pkg.name,
    packageDir: pkg.packageDir,
    grantPresent: grant !== undefined,
    provenanceMatched: grantMatches,
    message: `capability pack ${pkg.name} denied by trust policy`,
  });
  return capabilityPackProvenancePassthrough(pkg, { admit: false, reason });
}

/**
 * Human guidance for a denied pack. A stale grant (id matches, provenance
 * does not) gets its own message — the resolved pack is NOT the artifact the
 * operator verified, which is either an update or a shadowing attempt.
 */
function admissionDenialReason(
  pkg: SelectedCapabilityPackage,
  grantPresent: boolean,
  policyDecision: {
    readonly allowed: boolean;
    readonly decision: { readonly reasons: readonly string[] };
  },
): string {
  if (!policyDecision.allowed) return policyDecision.decision.reasons.join('; ');
  if (grantPresent) {
    return (
      `trusted provenance for ${pkg.name} does not match the resolved package — ` +
      `verify the pack, then re-run: opensip policy trust ${pkg.name}`
    );
  }
  return `not operator-trusted — verify the pack, then run: opensip policy trust ${pkg.name}`;
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
 *
 * Only packs that actually resolve under the CLI install tree are seeded. The
 * manifest may still list monorepo-only private packs (e.g. checks-dogfood) so
 * they remain trust-admitted when present, without emitting
 * "configured package … is not installed" noise on every published-install run —
 * that warning rides stderr and breaks pure `--json` under a PTY.
 */
function augmentBundledCapabilityPreferences(
  descriptor: CapabilityDiscoveryDescriptor,
  preferences: CapabilityPreferences,
  cliDir: string,
): CapabilityPreferences {
  if (preferences.packages !== undefined) return preferences;
  if (descriptor.discovery.mode !== 'marker') return preferences;
  const bundled = BUNDLED_CAPABILITY_PACKS[descriptor.discovery.markerKind];
  if (bundled === undefined || bundled.length === 0) return preferences;
  const installed = bundled.filter((name) => resolvePackageDir(cliDir, name) !== undefined);
  if (installed.length === 0) return preferences;
  return { ...preferences, packages: installed };
}
