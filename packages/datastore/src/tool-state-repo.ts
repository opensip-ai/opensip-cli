import { logger, ValidationError } from '@opensip-tools/core';
import { and, asc, eq } from 'drizzle-orm';

import { requireDrizzleDataStore, type DataStore, type DrizzleDataStore } from './data-store.js';
import { toolState } from './schema/tool-state.js';

const MODULE_NAME = 'datastore:tool-state-repo';

/**
 * Per-payload size ceiling (UTF-8 bytes of the JSON serialization). Exceeding
 * it ERRORS (a typed `ValidationError`) rather than evicting — silent eviction
 * hides bugs; an explicit cap teaches the tool author to shard or summarize.
 * Documented on the `cli.toolState` seam JSDoc (ADR-0042).
 */
export const TOOL_STATE_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * The generic host-owned keyed tool-state repository (ADR-0042). One repo over
 * the shared `tool_state` table, scoped by the `tool` column — every tool gets
 * durable keyed JSON persistence without owning schema, the same generic-table
 * pattern the ADR-0036 baseline pair proved. Tools consume it through the
 * `cli.toolState` seams; the payload is opaque to the host.
 */
export class ToolStateRepo {
  private readonly datastore: DrizzleDataStore;

  constructor(datastore: DataStore) {
    this.datastore = requireDrizzleDataStore(datastore);
  }

  /** Read one payload, or undefined when the key has never been put. */
  get(tool: string, key: string): unknown {
    const row = this.datastore.db
      .select({ payload: toolState.payload })
      .from(toolState)
      .where(and(eq(toolState.tool, tool), eq(toolState.key, key)))
      .limit(1)
      .get();
    return row?.payload ?? undefined;
  }

  /**
   * Upsert one payload under `(tool, key)`.
   *
   * @throws {ValidationError} when the JSON serialization exceeds
   *   {@link TOOL_STATE_MAX_PAYLOAD_BYTES} (error, never evict).
   */
  put(tool: string, key: string, payload: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(payload) ?? 'null', 'utf8');
    if (bytes > TOOL_STATE_MAX_PAYLOAD_BYTES) {
      // @fitness-ignore-next-line result-pattern-consistency -- documented @throws boundary (the cap errors, never evicts); exceptions propagate to the public Result/CommandOutcome boundary, matching the BaselineRepo/file-cache precedent
      throw new ValidationError(
        `tool_state payload for '${tool}/${key}' is ${bytes} bytes — over the ` +
          `${TOOL_STATE_MAX_PAYLOAD_BYTES}-byte cap (ADR-0042). Shard or summarize the payload.`,
        { code: 'VALIDATION.TOOL_STATE.PAYLOAD_TOO_LARGE' },
      );
    }
    const updatedAt = Date.now();
    this.datastore.db
      .insert(toolState)
      .values({ tool, key, payload, updatedAt })
      .onConflictDoUpdate({
        target: [toolState.tool, toolState.key],
        set: { payload, updatedAt },
      })
      .run();
    logger.debug({
      evt: 'datastore.tool_state.put',
      module: MODULE_NAME,
      tool,
      key,
      bytes,
    });
  }

  /** Delete one key (no-op when absent). */
  delete(tool: string, key: string): void {
    this.datastore.db
      .delete(toolState)
      .where(and(eq(toolState.tool, tool), eq(toolState.key, key)))
      .run();
  }

  /** List this tool's keys, sorted (never another tool's). */
  list(tool: string): readonly string[] {
    return this.datastore.db
      .select({ key: toolState.key })
      .from(toolState)
      .where(eq(toolState.tool, tool))
      .orderBy(asc(toolState.key))
      .all()
      .map((r) => r.key);
  }

  /** Delete ALL of this tool's state rows; returns the deleted count. */
  clear(tool: string): number {
    const result = this.datastore.db.delete(toolState).where(eq(toolState.tool, tool)).run();
    logger.info({
      evt: 'datastore.tool_state.clear.complete',
      module: MODULE_NAME,
      tool,
      count: result.changes,
    });
    return result.changes;
  }
}
