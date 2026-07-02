/**
 * @fileoverview The generic capability-contribution discovery substrate (§5.3).
 *
 * One walker that, given a capability domain's manifest-declared discovery
 * descriptor + resolved preferences, finds every contributing package (by marker
 * OR name-pattern), dynamic-imports each one, reads its declared export, and
 * yields the raw contributions. It hoists the common machinery behind fitness
 * check packs, simulation scenario packs, and graph adapters into one
 * descriptor-driven substrate.
 *
 * Pure infra: it takes NO scope, touches NO registry, and imports NO tool. It
 * yields `{ contribution, sourcePackage }` records that the host's capability
 * registry routes to the owning tool's registrar (Phase 2). Per-package failures
 * are isolated — a bad export or an import that throws skips that package with a
 * structured diagnostic, never the whole run.
 */

import { pathToFileURL } from 'node:url';

import { logger } from '../lib/logger.js';

import { readOneExport } from './capability-export-reader.js';
import { defaultPackageAdmission, selectPackages } from './capability-package-selection.js';
import { resolvePackageEntryPoint } from './package-entry.js';

import type {
  CapabilityDiscoveryDiagnostic,
  CapabilityPackageAdmission,
  DiscoverCapabilityContributionsOptions,
  RawCapabilityContribution,
  SelectedCapabilityPackage,
} from './capability-discovery-types.js';
import type { CapabilityDiscoveryDescriptor } from '../tools/capability.js';

export type {
  CapabilityDiscoveryDiagnostic,
  CapabilityDiscoveryPreferences,
  CapabilityIsolationLevel,
  CapabilityContributionLoader,
  CapabilityContributionLoadContext,
  CapabilityPackageAdmission,
  CapabilityResourceDecision,
  DiscoverCapabilityContributionsOptions,
  RawCapabilityContribution,
  SelectedCapabilityPackage,
} from './capability-discovery-types.js';

/**
 * Max packages imported concurrently. Per-package loads are independent, so we
 * fan them out — but in bounded batches, so a project with many capability packs
 * can't spawn unbounded parallel dynamic imports (each import is real I/O +
 * module-graph evaluation). Order is preserved across batches.
 */
const LOAD_CONCURRENCY = 8;

/**
 * Discover + load every contributing package for one capability domain and
 * return the flat list of raw contributions. See the file header for the
 * contract; per-package failures are isolated via `onDiagnostic`.
 */
export async function discoverCapabilityContributions(
  options: DiscoverCapabilityContributionsOptions,
): Promise<RawCapabilityContribution[]> {
  const packages = selectPackages(options);
  // Per-package loads are independent (each resolves + imports its own entry and
  // reads one export; no shared mutable state), so fan them out — but in bounded
  // batches of LOAD_CONCURRENCY, not unbounded. Promise.all preserves order within
  // a batch and batches run in sequence, so the flattened result is deterministic.
  const out: RawCapabilityContribution[] = [];
  for (let i = 0; i < packages.length; i += LOAD_CONCURRENCY) {
    const batch = packages.slice(i, i + LOAD_CONCURRENCY);
    const loaded = await Promise.all(batch.map((pkg) => loadPackageContributions(pkg, options)));
    for (const contributions of loaded) out.push(...contributions);
  }
  return out;
}

/**
 * Resolve a package's entry, dynamic-import it, and read the declared export.
 * `exportShape: 'array'` spreads the array; `'single'` yields the one value.
 * Missing package metadata, a missing/wrong-shape export, or an import that
 * throws all skip the package with a diagnostic — never propagate.
 */
async function loadPackageContributions(
  pkg: SelectedCapabilityPackage,
  options: DiscoverCapabilityContributionsOptions,
): Promise<RawCapabilityContribution[]> {
  const { descriptor, onDiagnostic, shouldLoadPackage } = options;
  const admission = shouldLoadPackage?.(pkg) ?? defaultPackageAdmission(pkg, descriptor);
  if (!admission.admit) {
    diagnoseDeniedPackage(pkg, admission, onDiagnostic);
    return [];
  }
  const loaded = await tryContributionLoader(pkg, descriptor, admission, options);
  if (loaded !== undefined) return loaded;
  if (admission.resourceDecision?.isolation === 'worker') {
    diagnoseIsolationUnsupported(pkg, onDiagnostic);
    return [];
  }
  const resolved = resolvePackageEntryPoint(pkg.packageDir, pkg.name);
  if (!resolved) {
    onDiagnostic?.({
      evt: 'capability.discovery.unreadable_package',
      packageName: pkg.name,
      message: `package ${pkg.name} has no readable package.json — skipping`,
    });
    return [];
  }
  try {
    const mod = (await import(pathToFileURL(resolved.entry).href)) as Record<string, unknown>;
    const metadataTag = {
      ...(pkg.packageTargetDomain === undefined
        ? {}
        : { packageTargetDomain: pkg.packageTargetDomain }),
      ...(pkg.packageTargetDomainApiVersion === undefined
        ? {}
        : {
            packageTargetDomainApiVersion: pkg.packageTargetDomainApiVersion,
          }),
      ...(pkg.packageRequires === undefined ? {} : { packageRequires: pkg.packageRequires }),
      ...(pkg.packageRequiresInvalid === true ? { packageRequiresInvalid: true } : {}),
      ...(pkg.packageManifestHash === undefined
        ? {}
        : { packageManifestHash: pkg.packageManifestHash }),
      ...(admission.resourceDecision === undefined
        ? {}
        : { resourceDecision: admission.resourceDecision }),
    };
    // Primary export (required — a missing/wrong-shape primary is diagnosed).
    const out = readOneExport(mod, pkg.name, onDiagnostic, {
      exportName: descriptor.exportName,
      exportShape: descriptor.exportShape,
      required: true,
      metadataTag,
    });
    // Co-contributions (§5.3): secondary exports routed to OTHER domains (e.g.
    // `recipes` → fit-recipe). OPTIONAL — a package that exports no recipes is
    // fine, so a missing co-export is silent (not diagnosed).
    for (const co of descriptor.coContributions ?? []) {
      out.push(
        ...readOneExport(mod, pkg.name, onDiagnostic, {
          exportName: co.exportName,
          exportShape: co.exportShape,
          targetDomainId: co.domainId,
          required: false,
          metadataTag,
        }),
      );
    }
    return out;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Structured log of the substrate's own failure (the caller's onDiagnostic is
    // a separate channel; this keeps the import failure observable in the logs even
    // when no diagnostic sink is wired). Per-package isolation: skip, never throw.
    logger.warn({
      evt: 'capability.discovery.load_failed',
      module: 'core:plugins',
      name: pkg.name,
      error: msg,
    });
    onDiagnostic?.({
      evt: 'capability.discovery.load_failed',
      packageName: pkg.name,
      message: `failed to load package ${pkg.name}: ${msg}`,
    });
    return [];
  }
}

function diagnoseDeniedPackage(
  pkg: SelectedCapabilityPackage,
  admission: Exclude<CapabilityPackageAdmission, { readonly admit: true }>,
  onDiagnostic: ((d: CapabilityDiscoveryDiagnostic) => void) | undefined,
): void {
  onDiagnostic?.({
    evt: 'capability.discovery.package_denied',
    packageName: pkg.name,
    message: `package ${pkg.name} denied by capability-pack trust policy: ${admission.reason}`,
  });
}

async function tryContributionLoader(
  pkg: SelectedCapabilityPackage,
  descriptor: CapabilityDiscoveryDescriptor,
  admission: Extract<CapabilityPackageAdmission, { readonly admit: true }>,
  options: DiscoverCapabilityContributionsOptions,
): Promise<RawCapabilityContribution[] | undefined> {
  const { contributionLoader, onDiagnostic } = options;
  if (contributionLoader === undefined) return undefined;
  try {
    const loaded = await contributionLoader(pkg, {
      descriptor,
      admission,
    });
    return loaded === undefined ? undefined : [...loaded];
  } catch (error) {
    return diagnoseLoadFailed(pkg, error, onDiagnostic);
  }
}

function diagnoseLoadFailed(
  pkg: SelectedCapabilityPackage,
  error: unknown,
  onDiagnostic: ((d: CapabilityDiscoveryDiagnostic) => void) | undefined,
): RawCapabilityContribution[] {
  const msg = error instanceof Error ? error.message : String(error);
  logger.warn({
    evt: 'capability.discovery.load_failed',
    module: 'core:plugins',
    name: pkg.name,
    error: msg,
  });
  onDiagnostic?.({
    evt: 'capability.discovery.load_failed',
    packageName: pkg.name,
    message: `failed to load package ${pkg.name}: ${msg}`,
  });
  return [];
}

function diagnoseIsolationUnsupported(
  pkg: SelectedCapabilityPackage,
  onDiagnostic: ((d: CapabilityDiscoveryDiagnostic) => void) | undefined,
): void {
  onDiagnostic?.({
    evt: 'capability.discovery.isolation_unsupported',
    packageName: pkg.name,
    message: `package ${pkg.name} requires worker isolation but no isolated capability loader is wired`,
  });
}
