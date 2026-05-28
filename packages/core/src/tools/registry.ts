// @fitness-ignore-file batch-operation-limits -- getAll() over the registered tool set (a handful of first-party + plugin tools per CLI invocation)
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
 * from accidentally clobbering first-party registrations.
 *
 * Implemented on top of the kernel's `Registry<T>` base. Tools don't
 * naturally satisfy `Registerable` (no `name` field on metadata), so
 * the registry wraps each Tool in a `{ id, name: id, tool }` envelope
 * before storing it. `list()` / `get()` unwrap.
 */

import { Registry, type Registerable } from '../lib/registry.js';

import type { Tool } from './types.js';

interface RegisterableTool extends Registerable {
  readonly id: string;
  readonly name: string;
  readonly tool: Tool;
}

export class ToolRegistry {
  private readonly inner = new Registry<RegisterableTool>({
    module: 'core:tools',
    duplicatePolicy: 'warn-first-wins',
    evtPrefix: 'tool.registry',
  });

  /**
   * Register a tool. **First writer wins** — re-registering the same
   * id is a no-op and emits a `tool.registry.duplicate` warning.
   */
  register(tool: Tool, opts: { sourcePackage?: string } = {}): void {
    const id = tool.metadata.id;
    this.inner.register({ id, name: id, tool }, { sourcePackage: opts.sourcePackage });
  }

  /**
   * Register a third-party tool. Equivalent to {@link register} today —
   * the duplicate-id policy lives entirely in the registry — but
   * exposes the discovery source as a structured log field so warnings
   * point at the offending package. Use this in CLI bootstrap when
   * iterating discovered npm packages.
   *
   * NEW CODE should use `register(tool, { sourcePackage })`. This
   * method survives as a back-compat alias for one minor release.
   */
  registerThirdParty(tool: Tool, opts: { sourcePackage?: string } = {}): void {
    this.register(tool, opts);
  }

  list(): readonly Tool[] {
    return this.inner.getAll().map((r) => r.tool);
  }

  get(id: string): Tool | undefined {
    return this.inner.getById(id)?.tool;
  }

  clear(): void {
    this.inner.clear();
  }
}
