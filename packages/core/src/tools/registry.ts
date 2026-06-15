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

/** Per-run registry of {@link Tool} plugins, indexed by the human name (metadata.name). */
export class ToolRegistry {
  private readonly inner = new Registry<RegisterableTool>({
    module: 'core:tools',
    duplicatePolicy: 'warn-first-wins',
    evtPrefix: 'tool.registry',
  });

  /**
   * Register a tool. **First writer wins** — re-registering the same
   * (human) id is a no-op and emits a `tool.registry.duplicate` warning.
   *
   * The registry is keyed by the human `metadata.name` (the former `id` value)
   * for continuity with callers that do registry.get('fitness') etc. The stable
   * UUID lives in metadata.id and is not used as the registry key.
   */
  register(tool: Tool, opts: { sourcePackage?: string } = {}): void {
    const key = tool.metadata.name ?? tool.metadata.id;
    this.inner.register({ id: key, name: key, tool }, { sourcePackage: opts.sourcePackage });
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
