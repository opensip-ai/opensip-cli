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
export {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isToolLongId,
  isToolShortId,
} from './ids.js';
export type { ToolLongId, ToolShortId } from './ids.js';
