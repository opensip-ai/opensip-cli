import {
  discoverPackagesByDeclaredKind,
  readDeclaredCapabilityPackageMetadata,
  type DiscoveredDeclaredPackage,
} from './marker-discovery.js';
import { discoverScopedPackages, resolvePackageDir } from './node-modules-walk.js';
import {
  coreDescriptionAt,
  filterSameCorePackages,
  selfCoreVersionString,
  selfScopeAbiVersion,
} from './single-core-guard.js';

import type {
  CapabilityDiscoveryDiagnostic,
  CapabilityPackageAdmission,
  DiscoverCapabilityContributionsOptions,
  SelectedCapabilityPackage,
} from './capability-discovery-types.js';
import type { CapabilityDiscoveryDescriptor } from '../tools/capability.js';

/**
 * Resolve which packages to load, applying the preference rules:
 *   - explicit `preferences.packages` list resolved (built-ins from `cliDir`);
 *   - auto-discovery (by the descriptor's mode) runs UNLESS `autoDiscover: false`
 *     OR (an explicit list is present AND `explicitListMode` is `'replace'`);
 *   - `'augment'` mode unions explicit + auto-discovered, deduped.
 * Finally, the single-core guard drops any pack resolving a foreign
 * `@opensip-cli/core` (a split run scope -> false positives).
 */
export function selectPackages(
  options: DiscoverCapabilityContributionsOptions,
): SelectedCapabilityPackage[] {
  const { descriptor, preferences = {}, onDiagnostic } = options;
  const explicitMode = descriptor.explicitListMode ?? 'replace';
  const hasExplicit = preferences.packages !== undefined;

  const explicit = hasExplicit ? resolveExplicit(preferences.packages ?? [], options) : [];
  // 'replace' + an explicit list -> skip auto-discovery; otherwise auto-discover
  // (unless opted out). 'augment' always auto-discovers and adds the explicit list.
  const includeAuto =
    preferences.autoDiscover !== false && !(hasExplicit && explicitMode === 'replace');
  const auto = includeAuto ? autoDiscover(options) : [];

  // Explicit config wins on a name collision (listed first).
  const merged = dedupeSelected([...explicit, ...auto]);
  return attachCapabilityMetadata(applySingleCoreGuard(merged, onDiagnostic));
}

/**
 * Default capability-pack admission: built-in packs may load in host-process;
 * external packs must be admitted by the CLI trust-policy PEP before loading.
 */
export function defaultPackageAdmission(
  pkg: SelectedCapabilityPackage,
  descriptor: CapabilityDiscoveryDescriptor,
): CapabilityPackageAdmission {
  if (isBuiltInSelectedPackage(pkg, descriptor)) return { admit: true };
  return {
    admit: false,
    reason: 'external capability packages require explicit host policy admission',
  };
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
 * `descriptor.builtinScope`) resolve from `cliDir`; the rest from `projectDir` -
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
        message: `configured package "${name}" is not installed in node_modules - skipping`,
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

function attachCapabilityMetadata(
  packages: readonly SelectedCapabilityPackage[],
): SelectedCapabilityPackage[] {
  return packages.map((pkg) => {
    const metadata = readDeclaredCapabilityPackageMetadata(pkg.packageDir);
    if (metadata === undefined) return pkg;
    return {
      ...pkg,
      ...(metadata.targetDomain === undefined
        ? {}
        : { packageTargetDomain: metadata.targetDomain }),
      ...(metadata.targetDomainApiVersion === undefined
        ? {}
        : { packageTargetDomainApiVersion: metadata.targetDomainApiVersion }),
      ...(metadata.requires === undefined ? {} : { packageRequires: metadata.requires }),
      ...(metadata.requiresInvalid === true ? { packageRequiresInvalid: true } : {}),
      ...(metadata.manifestHash === undefined
        ? {}
        : { packageManifestHash: metadata.manifestHash }),
    };
  });
}

/**
 * Single-core guard: drop any pack that resolves a different `@opensip-cli/core`
 * than this runtime (a split run scope -> false positives). Delegates to the
 * shared {@link filterSameCorePackages}; wraps each drop in a discovery diagnostic.
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
        `but this CLI uses ${selfVer} (scope ABI ${selfScopeAbiVersion()}) - skipping the pack ` +
        `because mismatched core scope ABIs cannot share run scope. ` +
        `Align the CLI and the pack's @opensip-cli/core to the same scope ABI ` +
        `(matching versions, or rebuild the pack against this CLI's @opensip-cli/* line).`,
    });
  });
}

function isBuiltInSelectedPackage(
  pkg: SelectedCapabilityPackage,
  descriptor: CapabilityDiscoveryDescriptor,
): boolean {
  if (descriptor.builtinScope !== undefined && isUnderScope(pkg.name, descriptor.builtinScope)) {
    return true;
  }
  return (
    descriptor.discovery.mode === 'name-pattern' &&
    descriptor.discovery.defaultScopes.some((scope) => isUnderScope(pkg.name, scope))
  );
}
