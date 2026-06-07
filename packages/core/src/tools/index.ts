/**
 * @fileoverview Tool plugin barrel.
 *
 * Public API for the Tool contract — the kernel-level plugin shape
 * that fitness, simulation, and future tools implement.
 */

export type {
  Tool,
  ToolMetadata,
  ToolCommandDescriptor,
  ToolCliContext,
  ToolPluginExports,
  LiveViewRenderer,
} from './types.js';
export { UnknownLiveViewError } from './types.js';
export { ToolRegistry } from './registry.js';
// Static tool-plugin manifest + the plugin-API epoch + provenance types
// (release 2.8.0). No runtime consumers yet — Phase 1+ wire these.
export { PLUGIN_API_VERSION } from './manifest.js';
export type {
  ToolPluginManifest,
  ToolCommandManifest,
  ToolProvenance,
  ToolSource,
} from './manifest.js';
// The single pure compatibility gate shared by the bundled + external
// admission paths (release 2.8.0).
export { checkCompatibility } from './compatibility.js';
export type { CompatibilityVerdict } from './compatibility.js';
export {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isToolLongId,
  isToolShortId,
} from './ids.js';
export type { ToolLongId, ToolShortId } from './ids.js';
