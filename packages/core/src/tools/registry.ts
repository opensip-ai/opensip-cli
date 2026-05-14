/**
 * Tool registry — in-memory list of registered Tool implementations.
 *
 * The CLI populates the registry at startup (first-party tools as
 * direct imports, third-party tools via tool-package-discovery), then
 * iterates `list()` to build its command tree.
 *
 * Registering the same tool id twice is silently a no-op: last-writer
 * wins on the existing entry. This matches the policy used by check
 * package discovery (a third-party pack can override a first-party
 * pack's display entry without crashing).
 */

import type { Tool } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * Register a tool. Re-registering the same id replaces the previous
   * entry — last writer wins. Mirrors the check-package-discovery
   * policy where a third-party can override a first-party pack.
   */
  register(tool: Tool): void {
    this.tools.set(tool.metadata.id, tool);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  clear(): void {
    this.tools.clear();
  }
}

/** Process-wide tool registry. The CLI uses this. */
export const defaultToolRegistry = new ToolRegistry();
