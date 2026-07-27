/**
 * VIOLATION fixture — `state` collapse.
 *
 * Reduced from the real confirmed site
 * `packages/agent-eval/src/runner/process-tree.ts:205-235`
 * (`DescendantTracker.sample()` / `.alive()`).
 *
 * `snapshotProcesses()` and `recordDescendants()` can fail for genuinely
 * different reasons — `/bin/ps` missing (ENOENT), the snapshot timeout firing,
 * the row-count ceiling being exceeded, a duplicate or invalid POSIX identity,
 * or a plain programmer error introduced by a refactor. Every one of them
 * lands on `this.failed = true`, so the containment summary can only ever say
 * `reliable: false` with no reason attached.
 */

interface ProcessIdentity {
  readonly pid: number;
}

export class DescendantTracker {
  private failed = false;
  private rootObservedAlive = false;
  private readonly tracked = new Map<number, ProcessIdentity>();

  public sample(): void {
    if (this.failed) return;
    try {
      this.recordDescendants(this.snapshotProcesses());
    } catch {
      this.failed = true;
      this.rootObservedAlive = false;
    }
  }

  public observe(): void {
    let snapshot: readonly ProcessIdentity[] = [];
    try {
      snapshot = this.snapshotProcesses();
    } catch {
      this.failed = true;
      this.rootObservedAlive = false;
    }
    for (const identity of snapshot) this.tracked.set(identity.pid, identity);
  }

  private snapshotProcesses(): readonly ProcessIdentity[] {
    return [];
  }

  private recordDescendants(snapshot: readonly ProcessIdentity[]): void {
    if (snapshot.length > 10_000) throw new Error('row ceiling exceeded');
  }
}
