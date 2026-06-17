/**
 * @fileoverview Plugin system barrel export
 *
 * Public API for plugin discovery and the kernel-level plugin types.
 * The generic plugin loader lives here too — tools (fitness, sim) plug
 * a domain-specific registerExports callback in. Capability package discovery
 * uses the descriptor-driven substrate exported from this package.
 */

export { discoverPlugins, readProjectPluginsList } from './discover.js';
export { loadPlugin, loadAllPlugins } from './loader.js';
export type { RegisterCtx, RegisteredCounts, RegisterExportsFn } from './loader.js';
export { resolvePackageEntryPoint } from './package-entry.js';
export { VALID_NPM_SCOPE_REGEX, resolveScopes } from './scope-validation.js';
export type { PackageEntryResolution } from './package-entry.js';
export {
  discoverToolPackages,
  discoverToolPackagesFromAnchors,
  readToolPackageMetadata,
} from './tool-package-discovery.js';
export type {
  ToolPackageDiscoveryOptions,
  ToolDiscoverySource,
  DiscoveredToolPackage,
  ToolPackageMetadata,
} from './tool-package-discovery.js';
// Universal JSON-value guards shared by the manifest loader, the discovery
// normalizer, and the config-layer preference resolver (one definition, no
// cross-package duplicated bodies).
export { isRecord, isStringArray } from './json-guards.js';
export {
  discoverPackagesByMarker,
  discoverPackagesByDeclaredKind,
  discoverPackagesInNodeModules,
  isMarkerKind,
  readMarkerKind,
  readDeclaredKind,
  MARKER_KINDS,
} from './marker-discovery.js';
export type { DiscoveredDeclaredPackage } from './marker-discovery.js';
// The generic capability-contribution discovery substrate (§5.3): one walker
// over marker + name-pattern modes that the host registry drives, replacing the
// three bespoke per-tool loaders. Yields raw contributions for routing.
export { discoverCapabilityContributions } from './capability-discovery.js';
export type {
  CapabilityDiscoveryPreferences,
  RawCapabilityContribution,
  CapabilityDiscoveryDiagnostic,
  DiscoverCapabilityContributionsOptions,
} from './capability-discovery.js';
export { discoverScopedPackages, hasPackageJson, resolvePackageDir } from './node-modules-walk.js';
export type {
  DiscoveredScopedPackage,
  DiscoverScopedPackagesOptions,
} from './node-modules-walk.js';
export type {
  MarkerKind,
  MarkerDiscoveryOptions,
  DiscoveredMarkerPackage,
} from './marker-discovery.js';
export { loadToolManifest, admitTool, PROJECT_LOCAL_MANIFEST_FILE } from './manifest-loader.js';
export type { AdmissionResult } from './manifest-loader.js';
// Authored-Tool sidecar discovery: a source-agnostic walk over a single
// authored `tools/` root that returns sidecar-bearing candidate dirs. The
// host assigns the ToolSource per root (project vs user-global).
export { discoverAuthoredToolSidecars } from './authored-tool-discovery.js';
export type { AuthoredToolCandidate } from './authored-tool-discovery.js';
// Scope-owned capability registry (launch, §5.3): the host-side
// runtime that registers manifest-declared capability domains and routes
// contributions to their owning tool's registrar. Per-RunScope — mirrors
// the simulation scenario-registry template.
export {
  CapabilityRegistry,
  createCapabilityRegistry,
  currentCapabilityRegistry,
  registerCapabilityDomainsFromManifest,
} from './capability-registry.js';
export type { CapabilityRegistrar } from './capability-registry.js';
// The scope-owned capability loader (§5.3, Phase 2): drives the generic
// discovery substrate for one domain and routes every contribution through
// `routeContribution` — the live conduit. Memoized per scope (fixes F1).
export { loadCapabilityDomain } from './capability-loader.js';
export type { LoadCapabilityDomainOptions } from './capability-loader.js';
export { registerRecipesFromMod } from './recipe-loader.js';
export type { RegisterRecipesOptions, RegisterRecipesResult } from './recipe-loader.js';
export type {
  PluginLayout,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  LangPluginExports,
  PluginExports,
} from './types.js';
