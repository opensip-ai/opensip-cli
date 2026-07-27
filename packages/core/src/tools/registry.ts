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

import { ErrorDefinitionError } from '../lib/error-definition.js';
import { Registry, type Registerable } from '../lib/registry.js';

import {
  aggregateErrorCatalogs,
  validateToolErrorCatalogContribution,
  type SubstrateErrorCatalogContribution,
} from './error-catalog.js';

import type { Tool } from './types.js';
import type { ErrorCatalog, ErrorDefinition } from '../lib/error-definition.js';

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

  /** Per-invocation index of tool error catalogs (rebuilt on register). */
  private catalogIndex: ReturnType<typeof aggregateErrorCatalogs> | undefined;

  /**
   * Substrate catalogs supplied by the composition root (Plan 01 ruling D1).
   *
   * Substrate packages are not Tools, so they have no `ToolExtensionPoints.errorCatalog` to
   * contribute through — yet they own codes, and a third-party tool claiming one of those
   * codes must be refused. Only the composition root knows which substrates are loaded, so
   * it supplies the list; the registry keeps the aggregate and the collision semantics.
   */
  private readonly substrateCatalogs: SubstrateErrorCatalogContribution[] = [];

  /**
   * Register a substrate package's error catalog.
   *
   * Idempotent per package name: the composition root may build more than one scope in a
   * process (the lightweight command probe does), and re-registering the same substrate must
   * not manufacture a self-collision.
   *
   * @throws {ErrorDefinitionError} When the substrate's codes collide with an already-known owner.
   */
  registerSubstrateCatalog(contribution: SubstrateErrorCatalogContribution): void {
    const existing = this.substrateCatalogs.findIndex(
      (c) => c.packageName === contribution.packageName,
    );
    if (existing >= 0) return;
    this.substrateCatalogs.push(contribution);
    this.catalogIndex = undefined;
    this.getErrorCatalogIndex();
  }

  /**
   * Register a tool. **First writer wins** — re-registering the same
   * (human) id is a no-op and emits a `tool.registry.duplicate` warning.
   *
   * The registry is keyed by the human `metadata.name` (the former `id` value)
   * for continuity with callers that do registry.get('fitness') etc. The stable
   * UUID lives in metadata.id and is not used as the registry key.
   *
   * When `extensionPoints.errorCatalog` is present, cross-tool code collisions
   * fail registration with {@link ErrorDefinitionError}.
   * @throws {ErrorDefinitionError} When the tool's error catalog collides with an already-registered code owned by a different tool.
   */
  register(tool: Tool, opts: { sourcePackage?: string } = {}): void {
    const key = tool.metadata.name ?? tool.metadata.id;
    // Preserve the registry's documented first-writer-wins behavior before
    // inspecting any fields on a duplicate plugin object. A duplicate cannot
    // make an already-admitted tool fail by attaching a hostile catalog.
    if (this.inner.getById(key) !== undefined) {
      this.inner.register({ id: key, name: key, tool }, { sourcePackage: opts.sourcePackage });
      return;
    }

    let admittedTool = tool;
    // Validate catalog aggregation *before* commit so a colliding catalog cannot
    // leave a half-registered tool in the registry.
    if (tool.extensionPoints?.errorCatalog) {
      const validated = validateToolErrorCatalogContribution(tool.extensionPoints.errorCatalog, {
        id: tool.metadata.id,
        displayName: tool.metadata.name,
        ...(opts.sourcePackage === undefined ? {} : { packageName: opts.sourcePackage }),
      });
      admittedTool = {
        ...tool,
        extensionPoints: {
          ...tool.extensionPoints,
          errorCatalog: validated.catalog,
        },
      };
      const provisional = aggregateErrorCatalogs(
        [
          ...this.collectToolCatalogs(),
          {
            toolName: tool.metadata.name,
            toolId: tool.metadata.id,
            catalog: validated.catalog,
          },
        ],
        this.substrateCatalogs,
      );
      if (provisional.collisions.length > 0) {
        const first = provisional.collisions[0];
        throw new ErrorDefinitionError(
          `error catalog collision on ${first.code} between ${first.owners.join(' and ')}`,
        );
      }
    }
    this.inner.register(
      { id: key, name: key, tool: admittedTool },
      { sourcePackage: opts.sourcePackage },
    );
    this.catalogIndex = undefined;
    // Warm the index so subsequent reads hit the cache (and re-throw if needed).
    this.getErrorCatalogIndex();
  }

  private collectToolCatalogs(): {
    toolName: string;
    toolId: string;
    catalog: ErrorCatalog;
  }[] {
    const toolCatalogs: { toolName: string; toolId: string; catalog: ErrorCatalog }[] = [];
    for (const registered of this.values()) {
      const catalog = registered.extensionPoints?.errorCatalog;
      if (catalog) {
        toolCatalogs.push({
          toolName: registered.metadata.name,
          toolId: registered.metadata.id,
          catalog,
        });
      }
    }
    return toolCatalogs;
  }

  /**
   * Aggregate core + loaded tool error catalogs for this invocation.
   * Throws if two tools claim the same code with different owners.
   * @throws {ErrorDefinitionError} When two tools claim the same code with different owners.
   */
  getErrorCatalogIndex(): {
    readonly byCode: ReadonlyMap<string, ErrorDefinition & { readonly toolName?: string }>;
  } {
    if (this.catalogIndex) {
      if (this.catalogIndex.collisions.length > 0) {
        const first = this.catalogIndex.collisions[0];
        throw new ErrorDefinitionError(
          `error catalog collision on ${first.code} between ${first.owners.join(' and ')}`,
        );
      }
      return this.catalogIndex;
    }

    this.catalogIndex = aggregateErrorCatalogs(this.collectToolCatalogs(), this.substrateCatalogs);
    if (this.catalogIndex.collisions.length > 0) {
      const first = this.catalogIndex.collisions[0];
      throw new ErrorDefinitionError(
        `error catalog collision on ${first.code} between ${first.owners.join(' and ')}`,
      );
    }
    return this.catalogIndex;
  }

  list(): readonly Tool[] {
    return [...this.values()];
  }

  /** Iterate registered tools in insertion order without allocating a snapshot array. */
  *values(): IterableIterator<Tool> {
    for (const registered of this.inner.values()) {
      yield registered.tool;
    }
  }

  /** Iterate registered tools in insertion order without allocating a snapshot array. */
  [Symbol.iterator](): IterableIterator<Tool> {
    return this.values();
  }

  get(id: string): Tool | undefined {
    return this.inner.getById(id)?.tool;
  }

  /** Remove one registered Tool by its registry key (normally metadata.name). */
  remove(id: string): boolean {
    const removed = this.inner.remove(id);
    if (removed) this.catalogIndex = undefined;
    return removed;
  }

  clear(): void {
    this.inner.clear();
    this.catalogIndex = undefined;
  }
}
