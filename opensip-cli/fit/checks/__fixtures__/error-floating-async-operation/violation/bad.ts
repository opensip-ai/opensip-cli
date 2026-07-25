/**
 * Violation fixture for `error-floating-async-operation`.
 *
 * Reduced from two REAL confirmed sites in this repository:
 *   - packages/mcp/src/local-codebase-read-port.ts:152
 *       `void refresh.promise.then(() => { ... });`
 *     The detached settle-bookkeeping chain registers no rejection handler.
 *     `refreshInventory` is expected never to reject, but its own catch block
 *     calls a log sink — a throwing sink escapes as a rejection with nowhere
 *     to go.
 *   - packages/agent-eval/src/runner/spawn.ts:390 / :320
 *       `void (terminationPromise ?? Promise.resolve()).then(() => { ... });`
 *       `void forceSettle();`
 *     Both terminal settlement paths discard rejections instead of settling
 *     the spawn promise.
 *
 * Expected: three findings (lines of the three detached statements).
 */

interface Refresh {
  promise: Promise<string>;
  settled: boolean;
}

export class InventoryPort {
  private inFlight: Refresh | undefined;

  private startRefresh(refresh: Refresh): void {
    this.inFlight = refresh;
    // R1: detached `.then(...)` with no rejection arm.
    void refresh.promise.then(() => {
      refresh.settled = true;
      if (this.inFlight === refresh) this.inFlight = undefined;
    });
  }
}

export function watchTermination(
  terminationPromise: Promise<void> | undefined,
  settle: (code: number) => void,
): void {
  // R1: same shape, parenthesised nullish-coalescing receiver.
  void (terminationPromise ?? Promise.resolve()).then(() => {
    settle(0);
  });
}

export function scheduleForceSettle(settle: (code: number) => void): void {
  const forceSettle = async (): Promise<void> => {
    await Promise.resolve();
    settle(1);
  };

  setTimeout(() => {
    // R2: `void` on a call that is provably async in this file.
    void forceSettle();
  }, 1000);
}
