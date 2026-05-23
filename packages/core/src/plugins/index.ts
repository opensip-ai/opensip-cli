/**
 * @fileoverview Plugin system barrel export
 *
 * Public API for plugin discovery and the kernel-level plugin types.
 * Tool-specific loaders (e.g. fitness's loadAllPlugins, fitness's
 * check-package-discovery) live with the tool that owns them.
 */

export {
  discoverPlugins,
  readProjectPluginsList,
} from './discover.js'
export {
  resolvePackageEntryPoint,
} from './package-entry.js'
export type {
  PackageEntryResolution,
} from './package-entry.js'
export {
  discoverToolPackages,
  readToolPackageMetadata,
} from './tool-package-discovery.js'
export type {
  ToolPackageDiscoveryOptions,
  DiscoveredToolPackage,
  ToolPackageMetadata,
} from './tool-package-discovery.js'
export type {
  PluginDomain,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  LangPluginExports,
  PluginExports,
  PluginMetadata,
  CheckDisplayEntry,
} from './types.js'
