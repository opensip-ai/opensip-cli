/**
 * @fileoverview Small module to isolate process-scoped idempotency globals.
 *
 * The `initializedToolIds` Set is intentionally process-scoped (for "at most once per process"
 * semantics of Tool.initialize(), as per the Tool contract).
 *
 * This module centralizes the global and its reset, making it easier to audit and test.
 * Resets are called on per-invocation context setup (aligning with RunScope isolation).
 *
 * This addresses the "process-scoped globals" Low from the architecture review.
 *
 * See pre-action-hook.ts and the GA roadmap item 5.
 */

/* eslint-disable sonarjs/no-empty-collection -- intentionally starts empty; populated on tool initialize, cleared per-run for isolation (GA Low hygiene) */
export const initializedToolIds = new Set<string>();

/** Reset for test harnesses and fresh invocations. */
export function resetInitializedToolIdsForTest(): void {
  initializedToolIds.clear();
}
