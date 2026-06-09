/**
 * @fileoverview The generic capability-contribution discovery substrate (§5.3).
 *
 * One walker that, given a capability domain's manifest-declared discovery
 * descriptor + resolved preferences, finds every contributing package (by marker
 * OR name-pattern), dynamic-imports each one, reads its declared export, and
 * yields the raw contributions. It hoists the machinery previously split across
 * three bespoke loaders — fitness's `check-loader.ts`, simulation's
 * `scenario-package-discovery.ts`, and graph's `graph-adapter-discovery.ts`.
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
    // @fitness-ignore-next-line performance-anti-patterns -- bounded fan-out: each batch runs in parallel via Promise.all; running batches serially caps in-flight imports (the bounded-concurrency pattern), not a per-item serial loop.
    const loaded = await Promise.all(batch.map((pkg) => loadPackageContributions(pkg, options)));
    for (const contributions of loaded) out.push(...contributions);
  }
  return out;
}

/**
 * Resolve which packages to load, applying the ordered preference rules:
 *   1. explicit `preferences.packages` list wins (auto-discovery skipped);
 *   2. else `autoDiscover === false` → none;
 *   3. else auto-discover by the descriptor's mode (marker | name-pattern).
 */
function selectPackages(options: DiscoverCapabilityContributionsOptions): SelectedPackage[] {
  const { descriptor, projectDir, cliDir, preferences = {}, onDiagnostic } = options;

  if (preferences.packages !== undefined) {
    return resolveExplicit(preferences.packages, projectDir, onDiagnostic);
  }
  if (preferences.autoDiscover === false) return [];

  return descriptor.discovery.mode === 'marker'
    ? autoDiscoverByMarker(descriptor, projectDir, cliDir)
    : autoDiscoverByNamePattern(descriptor, projectDir, preferences.scopes);
}

/** Resolve an explicit package-name list to on-disk dirs; diagnose any not installed. */
function resolveExplicit(
  names: readonly string[],
  projectDir: string,
  onDiagnostic?: (d: CapabilityDiscoveryDiagnostic) => void,
): SelectedPackage[] {
  const out: SelectedPackage[] = [];
  for (const name of names) {
    const packageDir = resolvePackageDir(projectDir, name);
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
    return readExport(mod, descriptor, pkg.name, onDiagnostic);
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

/** Read `mod[exportName]` per the descriptor's `exportShape`, diagnosing a mismatch. */
function readExport(
  mod: Record<string, unknown>,
  descriptor: CapabilityDiscoveryDescriptor,
  sourcePackage: string,
  onDiagnostic?: (d: CapabilityDiscoveryDiagnostic) => void,
): RawCapabilityContribution[] {
  const value = mod[descriptor.exportName];
  if (descriptor.exportShape === 'array') {
    if (!Array.isArray(value)) {
      onDiagnostic?.({
        evt: 'capability.discovery.bad_export',
        packageName: sourcePackage,
        message: `package ${sourcePackage} does not export a "${descriptor.exportName}" array — skipping`,
      });
      return [];
    }
    return (value as readonly unknown[]).map((contribution) => ({ contribution, sourcePackage }));
  }
  if (value === undefined) {
    onDiagnostic?.({
      evt: 'capability.discovery.bad_export',
      packageName: sourcePackage,
      message: `package ${sourcePackage} does not export "${descriptor.exportName}" — skipping`,
    });
    return [];
  }
  return [{ contribution: value, sourcePackage }];
}
