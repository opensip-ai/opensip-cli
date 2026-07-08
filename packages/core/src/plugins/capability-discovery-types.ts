import type { CapabilityDiscoveryDescriptor } from '../tools/capability.js';
import type { ToolResourceRequirement } from '../tools/manifest.js';

export type CapabilityIsolationLevel = 'host' | 'worker';

export interface CapabilityResourceDecision {
  readonly isolation: CapabilityIsolationLevel;
  readonly allowedResources: readonly ToolResourceRequirement[];
  readonly denyUndeclared: true;
  readonly reasons: readonly string[];
}

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
   * being discovered - i.e. a co-contribution (section 5.3): a `recipes` export read from
   * a fit-pack package, routed to the `fit-recipe` domain. `undefined` means the
   * primary domain (`descriptor`'s own domain).
   */
  readonly targetDomainId?: string;
  /** Package-declared target domain from `opensipTools.targetDomain`. */
  readonly packageTargetDomain?: string;
  /** Package-declared target epoch from `opensipTools.targetDomainApiVersion`. */
  readonly packageTargetDomainApiVersion?: number;
  /** Package-declared resource requirements from `opensipTools.requires`. */
  readonly packageRequires?: readonly ToolResourceRequirement[];
  readonly packageRequiresInvalid?: boolean;
  /** Stable hash of the package's `opensipTools` manifest block. */
  readonly packageManifestHash?: string;
  /** Admission-time resource decision for this package, when evaluated. */
  readonly resourceDecision?: CapabilityResourceDecision;
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

/** Policy-free admission decision for a selected capability package. */
export type CapabilityPackageAdmission =
  | { readonly admit: true; readonly resourceDecision?: CapabilityResourceDecision }
  | { readonly admit: false; readonly reason: string };

/**
 * Host-owned capability-pack admission gate, published on the RunScope
 * (`scope.capabilityAdmission`). Any engine that triggers its OWN capability load
 * — e.g. the fitness check-loader's `loadFitCheckPackages`, which runs for
 * fit/report contexts the host bootstrap does not drive — MUST route package
 * admission through this so it applies the SAME host trust policy (bundled +
 * explicit `plugins.<packages>` + env allowlist) instead of a permissive
 * builtin-default that would let a non-bundled `@opensip-cli/*` pack (e.g. the
 * private dogfood pack) slip in. Undefined outside a host-constructed scope
 * (programmatic use), where the core default admission applies. The signature
 * matches the host's `admitCapabilityPackage` exactly, so the host assigns that
 * function directly — no adapter.
 */
export type CapabilityPackAdmission = (
  descriptor: CapabilityDiscoveryDescriptor,
  pkg: SelectedCapabilityPackage,
  explicitlyConfigured: ReadonlySet<string>,
) => CapabilityPackageAdmission;

export interface CapabilityContributionLoadContext {
  readonly descriptor: CapabilityDiscoveryDescriptor;
  readonly admission: Extract<CapabilityPackageAdmission, { readonly admit: true }>;
}

export type CapabilityContributionLoader = (
  pkg: SelectedCapabilityPackage,
  context: CapabilityContributionLoadContext,
) => Promise<readonly RawCapabilityContribution[] | undefined>;

/** A package selected for loading: its name + on-disk directory. */
export interface SelectedCapabilityPackage {
  readonly name: string;
  readonly packageDir: string;
  readonly packageTargetDomain?: string;
  readonly packageTargetDomainApiVersion?: number;
  readonly packageRequires?: readonly ToolResourceRequirement[];
  readonly packageRequiresInvalid?: boolean;
  readonly packageManifestHash?: string;
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
  /** Optional pre-import package admission gate. Core emits diagnostics, policy lives with the caller. */
  readonly shouldLoadPackage?: (pkg: SelectedCapabilityPackage) => CapabilityPackageAdmission;
  /** Optional caller-owned contribution loader, used for worker-backed isolation. */
  readonly contributionLoader?: CapabilityContributionLoader;
  /** Sink for non-fatal per-package diagnostics. */
  readonly onDiagnostic?: (diagnostic: CapabilityDiscoveryDiagnostic) => void;
}
