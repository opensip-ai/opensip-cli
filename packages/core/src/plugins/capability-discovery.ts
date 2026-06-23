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

import {
  discoverPackagesByDeclaredKind,
  type DiscoveredDeclaredPackage,
} from './marker-discovery.js';
import { discoverScopedPackages, resolvePackageDir } from './node-modules-walk.js';
import { resolvePackageEntryPoint } from './package-entry.js';
import { filterSameCorePackages, selfCore } from './single-core-guard.js';

import type { CapabilityDiscoveryDescriptor } from '../tools/capability.js';

/**
 * Resolved discovery preferences for one domain. The host resolves these from
 * project config (Phase 3) against the descriptor's `configKeys`; the substrate
 * just applies them. Absent `packages` means "auto-discover"; `autoDiscover:
 * false` disables it; an explicit `packages` list always wins over auto-discovery.
 */
export interface CapabilityDiscoveryPreferences {
  /** Explicit package-name list. When present (even empty), auto-discovery is skipped. */
  readonly packages?: readonly string[];
  /** Disable auto-discovery (name-pattern/marker walk). Default: true (enabled). */
  readonly autoDiscover?: boolean;
  /** name-pattern mode only: scopes to scan, overriding the descriptor's `defaultScopes`. */
  readonly scopes?: readonly string[];
}

/** A raw contribution yielded by discovery, tagged with the package it came from. */
export interface RawCapabilityContribution {
  /** The contribution value read from the package's declared export (unvalidated). */
  readonly contribution: unknown;
  /** npm package name the contribution came from, for diagnostics + provenance. */
  readonly sourcePackage: string;
  /**
   * The domain this contribution routes to, when it is NOT the primary domain
   * being discovered — i.e. a co-contribution (§5.3): a `recipes` export read from
   * a fit-pack package, routed to the `fit-recipe` domain. `undefined` means the
   * primary domain (`descriptor`'s own domain).
   */
  readonly targetDomainId?: string;
}

/** A structured non-fatal discovery diagnostic (missing package, bad export, import throw). */
export interface CapabilityDiscoveryDiagnostic {
  /** Stable event id, e.g. `capability.discovery.package_not_resolved`. */
  readonly evt: string;
  /** The package the diagnostic concerns, when known. */
  readonly packageName?: string;
  /** Human-readable message. */
  readonly message: string;
}

/** Options for {@link discoverCapabilityContributions}. */
export interface DiscoverCapabilityContributionsOptions {
  /** The domain's manifest-declared discovery descriptor. */
  readonly descriptor: CapabilityDiscoveryDescriptor;
  /** Discovery anchor for consumer-owned packages (the project root). */
  readonly projectDir: string;
  /**
   * Discovery anchor for BUILT-IN packages (those under `descriptor.builtinScope`).
   * When the descriptor declares a `builtinScope`, packages under that scope are
   * resolved from here (the CLI's own install tree) instead of `projectDir`, so a
   * project pinning an older copy cannot shadow the bundled built-in. Ignored when
   * the descriptor declares no `builtinScope`.
   */
  readonly cliDir?: string;
  /** Resolved preferences (explicit list / opt-out / scopes). */
  readonly preferences?: CapabilityDiscoveryPreferences;
  /** Sink for non-fatal per-package diagnostics. */
  readonly onDiagnostic?: (diagnostic: CapabilityDiscoveryDiagnostic) => void;
}

/** A package selected for loading: its name + on-disk directory. */
interface SelectedPackage {
  readonly name: string;
  readonly packageDir: string;
}

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
function selectPackages(options: DiscoverCapabilityContributionsOptions): SelectedPackage[] {
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
function autoDiscover(options: DiscoverCapabilityContributionsOptions): SelectedPackage[] {
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
): SelectedPackage[] {
  const { descriptor, projectDir, cliDir, onDiagnostic } = options;
  const scope = descriptor.builtinScope;
  const out: SelectedPackage[] = [];
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
): SelectedPackage[] {
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
): SelectedPackage[] {
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
function dedupe(packages: readonly DiscoveredDeclaredPackage[]): SelectedPackage[] {
  const seen = new Set<string>();
  const out: SelectedPackage[] = [];
  for (const p of packages) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, packageDir: p.packageDir });
  }
  return out;
}

/** Dedupe selected packages by name (first occurrence wins). */
function dedupeSelected(packages: readonly SelectedPackage[]): SelectedPackage[] {
  const seen = new Set<string>();
  const out: SelectedPackage[] = [];
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
  packages: readonly SelectedPackage[],
  onDiagnostic?: (d: CapabilityDiscoveryDiagnostic) => void,
): SelectedPackage[] {
  return filterSameCorePackages(packages, (pkg, foreignCore) => {
    onDiagnostic?.({
      evt: 'capability.discovery.foreign_core',
      packageName: pkg.name,
      message:
        `package ${pkg.name} resolves a different @opensip-cli/core (${foreignCore}) than this ` +
        `runtime (${selfCore() ?? '<unknown>'}) — skipping to avoid a split run scope`,
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
  pkg: SelectedPackage,
  options: DiscoverCapabilityContributionsOptions,
): Promise<RawCapabilityContribution[]> {
  const { descriptor, onDiagnostic } = options;
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
    // Primary export (required — a missing/wrong-shape primary is diagnosed).
    const out = readOneExport(mod, pkg.name, onDiagnostic, {
      exportName: descriptor.exportName,
      exportShape: descriptor.exportShape,
      required: true,
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

/** Which export to read from a package module, and how. */
interface ExportSpec {
  readonly exportName: string;
  readonly exportShape: 'array' | 'single';
  /** The domain co-contributions route to; undefined = the primary domain. */
  readonly targetDomainId?: string;
  /** When true, a missing/wrong-shape export is diagnosed; when false, silent (optional co-export). */
  readonly required: boolean;
}

/**
 * Read one export (`mod[spec.exportName]`) per `spec.exportShape`, tagging each
 * contribution with `spec.targetDomainId` (undefined = the primary domain).
 * `spec.required` governs the missing-export behavior: a missing PRIMARY export
 * is diagnosed + skipped; a missing co-contribution export is silent.
 */
function readOneExport(
  mod: Record<string, unknown>,
  sourcePackage: string,
  onDiagnostic: ((d: CapabilityDiscoveryDiagnostic) => void) | undefined,
  spec: ExportSpec,
): RawCapabilityContribution[] {
  const { exportName, exportShape, targetDomainId, required } = spec;
  const tag = targetDomainId === undefined ? {} : { targetDomainId };
  const value = mod[exportName];
  if (exportShape === 'array') {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) {
      if (required) {
        onDiagnostic?.({
          evt: 'capability.discovery.bad_export',
          packageName: sourcePackage,
          message: `package ${sourcePackage} does not export a "${exportName}" array — skipping`,
        });
      }
      return [];
    }
    return (value as readonly unknown[]).map((contribution) => ({
      contribution,
      sourcePackage,
      ...tag,
    }));
  }
  if (value === undefined) {
    if (required) {
      onDiagnostic?.({
        evt: 'capability.discovery.bad_export',
        packageName: sourcePackage,
        message: `package ${sourcePackage} does not export "${exportName}" — skipping`,
      });
    }
    return [];
  }
  return [{ contribution: value, sourcePackage, ...tag }];
}
