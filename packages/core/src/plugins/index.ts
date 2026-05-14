/**
 * @fileoverview Plugin system barrel export
 *
 * Public API for plugin discovery and the kernel-level plugin types.
 * Tool-specific loaders (e.g. fitness's loadAllPlugins) live with the
 * tool that owns them.
 */

export {
  discoverPlugins,
  getPluginDir,
  getBaseDir,
  getProjectPluginDir,
  resolvePluginDir,
  hasProjectPluginsDeclared,
  readProjectPluginsList,
} from './discover.js'
export {
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
} from './check-package-discovery.js'
export type {
  CheckPackageDiscoveryOptions,
  DiscoveredCheckPackage,
  CheckPackageMetadata,
} from './check-package-discovery.js'
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
