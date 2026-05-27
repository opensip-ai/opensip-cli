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
