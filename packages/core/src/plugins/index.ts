/**
 * @fileoverview Plugin system barrel export
 *
 * Public API for plugin discovery and loading:
 * - discoverPlugins() — Scan ~/.opensip-tools/{fit,sim,asm}/ for plugins
 * - loadAllPlugins() — Discover + load + register all plugins for a domain
 * - getPluginDir() — Get the absolute path to a domain directory
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
export { loadPlugin, loadAllPlugins } from './loader.js'
export type {
  PluginDomain,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  FitPluginExports,
  LangPluginExports,
  PluginExports,
  PluginMetadata,
} from './types.js'
