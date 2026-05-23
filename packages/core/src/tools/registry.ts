/**
 * Tool registry — in-memory list of registered Tool implementations.
 *
 * The CLI populates the registry at startup (first-party tools as
 * direct imports, third-party tools via tool-package-discovery), then
 * iterates `list()` to build its command tree.
 *
 * **Duplicate-id policy: first writer wins.** Re-registering the same
 * id keeps the existing entry and emits a structured warning. This
 * matches `LanguageRegistry`'s policy and prevents third-party plugins
 * from accidentally clobbering first-party registrations. The CLI's
 * tool-discovery skip-by-id guard is now a defense-in-depth check
 * rather than the only protection.
 */

import { logger } from '../lib/logger.js';

import type { Tool } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * Register a tool. **First writer wins** — re-registering the same
   * id is a no-op and emits a `tool.registry.duplicate` warning.
   * Identical semantics to `LanguageRegistry.register`.
   */
  register(tool: Tool): void {
    const id = tool.metadata.id;
    if (this.tools.has(id)) {
      logger.warn({
        evt: 'tool.registry.duplicate',
        module: 'core:tools',
        id,
        msg: `Tool id ${id} already registered — keeping incumbent`,
      });
      return;
    }
    this.tools.set(id, tool);
  }

  /**
   * Register a third-party tool. Equivalent to {@link register} today —
   * the duplicate-id policy lives entirely in the registry — but
   * exposes the discovery source as a structured log field so warnings
   * point at the offending package. Use this in CLI bootstrap when
   * iterating discovered npm packages.
   */
  registerThirdParty(tool: Tool, opts: { sourcePackage?: string } = {}): void {
    const id = tool.metadata.id;
    if (this.tools.has(id)) {
      logger.warn({
        evt: 'tool.registry.duplicate',
        module: 'core:tools',
        id,
        sourcePackage: opts.sourcePackage,
        msg: `Tool id ${id} already registered — third-party registration from ${opts.sourcePackage ?? '<unknown>'} ignored`,
      });
      return;
    }
    this.tools.set(id, tool);
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
