/** Per-invocation binding between the serial agent-context producer steps. */

export interface ContextRunInputs {
  readonly inventorySnapshotId: string;
  readonly graphSnapshotId: string;
}

/**
 * Narrow mutable state owned by one RunScope. Producer attempts clear their
 * previous binding before work starts, so a failed step can never leave a
 * reusable success from an earlier chain in the same invocation.
 */
export interface ContextRunState {
  beginInventory(): void;
  completeInventory(snapshotId: string): void;
  beginGraph(): void;
  completeGraph(snapshotId: string): void;
  completeTestSelection(snapshotId: string): void;
  readonly protectedSnapshotIds: readonly string[];
  inputs(): ContextRunInputs | undefined;
}

export function createContextRunState(): ContextRunState {
  let inventorySnapshotId: string | undefined;
  let graphSnapshotId: string | undefined;
  let testSelectionSnapshotId: string | undefined;
  return Object.freeze({
    beginInventory: () => {
      inventorySnapshotId = undefined;
      graphSnapshotId = undefined;
      testSelectionSnapshotId = undefined;
    },
    completeInventory: (snapshotId: string) => {
      inventorySnapshotId = snapshotId;
    },
    beginGraph: () => {
      graphSnapshotId = undefined;
    },
    completeGraph: (snapshotId: string) => {
      graphSnapshotId = snapshotId;
    },
    completeTestSelection: (snapshotId: string) => {
      testSelectionSnapshotId = snapshotId;
    },
    get protectedSnapshotIds() {
      return Object.freeze(
        [inventorySnapshotId, testSelectionSnapshotId].filter(
          (snapshotId): snapshotId is string => snapshotId !== undefined,
        ),
      );
    },
    inputs: () =>
      inventorySnapshotId === undefined || graphSnapshotId === undefined
        ? undefined
        : { inventorySnapshotId, graphSnapshotId },
  });
}
