/**
 * @fileoverview Plugin system barrel export
 *
 * Public API for plugin discovery and the kernel-level plugin types.
 * The generic plugin loader lives here too — tools (fitness, sim) plug
 * a domain-specific registerExports callback in. Tool-specific
 * discovery helpers (check-package-discovery, scenario-package-
 * discovery) still live with the tool that owns them.
 */

export {
  discoverPlugins,
  readProjectPluginsList,
} from './discover.js'
export {
  loadPlugin,
  loadAllPlugins,
} from './loader.js'
export type {
  RegisterCtx,
  RegisteredCounts,
  RegisterExportsFn,
} from './loader.js'
export {
  resolvePackageEntryPoint,
} from './package-entry.js'
export {
  VALID_NPM_SCOPE_REGEX,
  resolveScopes,
} from './scope-validation.js'
export type {
  PackageEntryResolution,
} from './package-entry.js'
export {
  discoverToolPackages,
  discoverToolPackagesFromAnchors,
  readToolPackageMetadata,
} from './tool-package-discovery.js'
export type {
  ToolPackageDiscoveryOptions,
  ToolDiscoverySource,
  DiscoveredToolPackage,
  ToolPackageMetadata,
} from './tool-package-discovery.js'
export {
  discoverPackagesByMarker,
  discoverPackagesInNodeModules,
  isMarkerKind,
  readMarkerKind,
  MARKER_KINDS,
} from './marker-discovery.js'
export {
  discoverScopedPackages,
  hasPackageJson,
  resolvePackageDir,
} from './node-modules-walk.js'
export type {
  DiscoveredScopedPackage,
  DiscoverScopedPackagesOptions,
} from './node-modules-walk.js'
export type {
  MarkerKind,
  MarkerDiscoveryOptions,
  DiscoveredMarkerPackage,
} from './marker-discovery.js'
export {
  registerRecipesFromMod,
} from './recipe-loader.js'
export type {
  RegisterRecipesOptions,
  RegisterRecipesResult,
} from './recipe-loader.js'
export type {
  PluginLayout,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  LangPluginExports,
  PluginExports,
} from './types.js'
