/**
 * @fileoverview Tool plugin barrel.
 *
 * Public API for the Tool contract — the kernel-level plugin shape
 * that fitness, simulation, and future tools implement.
 */

export type {
  Tool,
  ToolMetadata,
  ToolCommand,
  ToolRunContext,
  ToolRunResult,
  ToolPluginExports,
} from './types.js';
export { ToolRegistry, defaultToolRegistry } from './registry.js';
