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
import {
  discoverPackagesByDeclaredKind,
  readDeclaredCapabilityPackageMetadata,
  type DiscoveredDeclaredPackage,
} from './marker-discovery.js';
import { discoverScopedPackages, resolvePackageDir } from './node-modules-walk.js';
import { resolvePackageEntryPoint } from './package-entry.js';
import {
  coreDescriptionAt,
  filterSameCorePackages,
  selfCoreVersionString,
  selfScopeAbiVersion,
} from './single-core-guard.js';

import type {
  CapabilityDiscoveryDiagnostic,
  DiscoverCapabilityContributionsOptions,
  RawCapabilityContribution,
  SelectedCapabilityPackage,
} from './capability-discovery-types.js';
import type { CapabilityDiscoveryDescriptor } from '../tools/capability.js';

export type {
  CapabilityDiscoveryDiagnostic,
  CapabilityDiscoveryPreferences,
  CapabilityPackageAdmission,
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
 * Resolve which packages to load, applying the preference rules:
 *   - explicit `preferences.packages` list resolved (built-ins from `cliDir`);
 *   - auto-discovery (by the descriptor's mode) runs UNLESS `autoDiscover: false`
 *     OR (an explicit list is present AND `explicitListMode` is `'replace'`);
 *   - `'augment'` mode unions explicit + auto-discovered, deduped.
 * Finally, the single-core guard drops any pack resolving a foreign
 * `@opensip-cli/core` (a split run scope → false positives).
 */
function selectPackages(
  options: DiscoverCapabilityContributionsOptions,
): SelectedCapabilityPackage[] {
  const { descriptor, preferences = {}, onDiagnostic } = options;
  const explicitMode = descriptor.explicitListMode ?? 'replace';
  const hasExplicit = preferences.packages !== undefined;

  const explicit = hasExplicit ? resolveExplicit(preferences.packages ?? [], options) : [];
  // 'replace' + an explicit list → skip auto-discovery; otherwise auto-discover
  // (unless opted out). 'augment' always auto-discovers and adds the explicit list.
  const includeAuto =
    preferences.autoDiscover !== false && !(hasExplicit && explicitMode === 'replace');
  const auto = includeAuto ? autoDiscover(options) : [];

  // Explicit config wins on a name collision (listed first).
  const merged = dedupeSelected([...explicit, ...auto]);
  return applySingleCoreGuard(merged, onDiagnostic);
}

/** Auto-discover packages by the descriptor's mode (marker | name-pattern). */
function autoDiscover(
  options: DiscoverCapabilityContributionsOptions,
): SelectedCapabilityPackage[] {
  const { descriptor, projectDir, cliDir, preferences = {} } = options;
  return descriptor.discovery.mode === 'marker'
    ? autoDiscoverByMarker(descriptor, projectDir, cliDir)
    : autoDiscoverByNamePattern(descriptor, projectDir, preferences.scopes);
}

/**
 * Resolve an explicit package-name list to on-disk dirs. Built-in names (under
 * `descriptor.builtinScope`) resolve from `cliDir`; the rest from `projectDir` —
 * the same ownership split auto-discovery applies. Diagnose any not installed.
 */
function resolveExplicit(
  names: readonly string[],
  options: DiscoverCapabilityContributionsOptions,
): SelectedCapabilityPackage[] {
  const { descriptor, projectDir, cliDir, onDiagnostic } = options;
  const scope = descriptor.builtinScope;
  const out: SelectedCapabilityPackage[] = [];
  for (const name of names) {
    const anchor =
      scope !== undefined && cliDir !== undefined && isUnderScope(name, scope)
        ? cliDir
        : projectDir;
    const packageDir = resolvePackageDir(anchor, name);
    if (packageDir) {
      out.push({ name, packageDir });
    } else {
      onDiagnostic?.({
        evt: 'capability.discovery.package_not_resolved',
        packageName: name,
        message: `configured package "${name}" is not installed in node_modules — skipping`,
      });
    }
  }
  return out;
}

/**
 * Marker mode. When the descriptor declares a `builtinScope`, packages split by
 * ownership: built-ins (names under the scope) resolve from `cliDir`; everything
 * else from `projectDir`, and a project-installed built-in is dropped as a shadow.
 * Without a `builtinScope`, all markers resolve from `projectDir`.
 */
function autoDiscoverByMarker(
  descriptor: CapabilityDiscoveryDescriptor,
  projectDir: string,
  cliDir: string | undefined,
): SelectedCapabilityPackage[] {
  if (descriptor.discovery.mode !== 'marker') return [];
  const { markerKind } = descriptor.discovery;
  const scope = descriptor.builtinScope;

  if (scope === undefined || cliDir === undefined) {
    return dedupe(discoverPackagesByDeclaredKind(projectDir, markerKind));
  }
  const builtin = discoverPackagesByDeclaredKind(cliDir, markerKind).filter((p) =>
    isUnderScope(p.name, scope),
  );
  const custom = discoverPackagesByDeclaredKind(projectDir, markerKind).filter(
    (p) => !isUnderScope(p.name, scope),
  );
  return dedupe([...builtin, ...custom]);
}

/** name-pattern mode: scan the descriptor's (or override) scopes for `<scope>/<prefix>*`. */
function autoDiscoverByNamePattern(
  descriptor: CapabilityDiscoveryDescriptor,
  projectDir: string,
  scopeOverride: readonly string[] | undefined,
): SelectedCapabilityPackage[] {
  if (descriptor.discovery.mode !== 'name-pattern') return [];
  const { prefix, defaultScopes } = descriptor.discovery;
  const scopes = scopeOverride ?? defaultScopes;
  return discoverScopedPackages({ projectDir, scopes, prefix }).map((p) => ({
    name: p.name,
    packageDir: p.packageDir,
  }));
}

/** A package name is "under" a scope when it begins with `<scope>/`. */
function isUnderScope(name: string, scope: string): boolean {
  return name.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
}

/** Dedupe discovered packages by name (first occurrence wins) and drop the kind tag. */
function dedupe(packages: readonly DiscoveredDeclaredPackage[]): SelectedCapabilityPackage[] {
  const seen = new Set<string>();
  const out: SelectedCapabilityPackage[] = [];
  for (const p of packages) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, packageDir: p.packageDir });
  }
  return out;
}

/** Dedupe selected packages by name (first occurrence wins). */
function dedupeSelected(
  packages: readonly SelectedCapabilityPackage[],
): SelectedCapabilityPackage[] {
  const seen = new Set<string>();
  const out: SelectedCapabilityPackage[] = [];
  for (const p of packages) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

/**
 * Single-core guard: drop any pack that resolves a DIFFERENT `@opensip-cli/core`
 * than this runtime (a split run scope → false positives). Delegates to the shared
 * {@link filterSameCorePackages}; wraps each drop in a discovery diagnostic.
 * Generic: every domain's packs get the guard, not just fit's.
 */
function applySingleCoreGuard(
  packages: readonly SelectedCapabilityPackage[],
  onDiagnostic?: (d: CapabilityDiscoveryDiagnostic) => void,
): SelectedCapabilityPackage[] {
  return filterSameCorePackages(packages, (pkg, foreignCore) => {
    const foreign = coreDescriptionAt(foreignCore);
    const foreignVer = foreign.version ?? '<unknown version>';
    const selfVer = selfCoreVersionString() ?? '<unknown version>';
    const foreignAbi =
      foreign.scopeAbi === undefined ? 'pre-shared-scope' : `scope ABI ${foreign.scopeAbi}`;
    onDiagnostic?.({
      evt: 'capability.discovery.foreign_core',
      packageName: pkg.name,
      message:
        `package ${pkg.name} was built against @opensip-cli/core ${foreignVer} (${foreignAbi}), ` +
        `but this CLI uses ${selfVer} (scope ABI ${selfScopeAbiVersion()}) — skipping the pack ` +
        `because mismatched core scope ABIs cannot share run scope. ` +
        `Align the CLI and the pack's @opensip-cli/core to the same scope ABI ` +
        `(matching versions, or rebuild the pack against this CLI's @opensip-cli/* line).`,
    });
  });
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
  const admission = shouldLoadPackage?.(pkg) ?? { admit: true };
  if (!admission.admit) {
    onDiagnostic?.({
      evt: 'capability.discovery.package_denied',
      packageName: pkg.name,
      message: `package ${pkg.name} denied by capability-pack trust policy: ${admission.reason}`,
    });
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
    const packageMetadata = readDeclaredCapabilityPackageMetadata(pkg.packageDir);
    const metadataTag = {
      ...(packageMetadata?.targetDomain === undefined
        ? {}
        : { packageTargetDomain: packageMetadata.targetDomain }),
      ...(packageMetadata?.targetDomainApiVersion === undefined
        ? {}
        : {
            packageTargetDomainApiVersion: packageMetadata.targetDomainApiVersion,
          }),
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
