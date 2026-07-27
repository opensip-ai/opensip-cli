/** Synchronous cleanup effect safe to invoke from a process signal/fatal boundary. */
export type InterruptCleanup = () => void;

const activeCleanups = new Set<InterruptCleanup>();

/** Register one live harness resource and return an idempotent release function. */
export function registerInterruptCleanup(cleanup: InterruptCleanup): () => void {
  activeCleanups.add(cleanup);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCleanups.delete(cleanup);
  };
}

/** Best-effort LIFO cleanup for process-level termination paths that cannot unwind. */
export function runInterruptCleanups(): void {
  const cleanups = [...activeCleanups];
  activeCleanups.clear();
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    const cleanup = cleanups[index];
    if (cleanup === undefined) continue;
    try {
      cleanup();
    } catch {
      // A process-level boundary has nowhere safer to report cleanup failure.
    }
  }
}

/** Test-only cleanup registry reset. */
export function resetInterruptCleanupsForTests(): void {
  activeCleanups.clear();
}
